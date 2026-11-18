package io.reporthub.reportstudio.gateway;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Job;
import io.reporthub.reportstudio.domain.OutputFile;
import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;
import io.reporthub.reportstudio.engine.EngineResolver;
import io.reporthub.reportstudio.domain.ReportUnit;
import io.reporthub.reportstudio.domain.ReportUnitFile;
import io.reporthub.reportstudio.repo.JobRepository;
import io.reporthub.reportstudio.repo.OutputFileRepository;
import io.reporthub.reportstudio.repo.ReportUnitFileRepository;
import io.reporthub.reportstudio.repo.ReportUnitRepository;
import io.reporthub.reportstudio.storage.ObjectStorageService;
import io.reporthub.reportstudio.storage.StoredObjectMeta;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Queue poller that performs the actual render → store pipeline for queued jobs.
 *
 * <p>Every {@code app.queue.poll-ms} the worker claims as many queued jobs as it has free render slots
 * ({@code app.render.concurrency} minus jobs in flight) through {@link JobQueue#claim}, which uses
 * {@code FOR UPDATE SKIP LOCKED} so several worker pods never take the same job.
 *
 * <p>Lifecycle per job: read the {@link JobMessage} payload, move the job to
 * {@code running}/stage {@code worker}, then stage {@code jasper}, invoke {@link ReportRenderer},
 * persist the bytes through {@link ObjectStorageService}, record an {@link OutputFile} row, and
 * finish at stage {@code store} / state {@code done} / progress {@code 100}. Any failure flips the
 * job to state {@code error}.
 *
 * <p>While a job renders the worker bumps its {@code heartbeat_at} every {@code app.queue.heartbeat-ms};
 * {@link #failOrphanedRunningJobs} fails running jobs whose heartbeat went stale (their worker died).
 *
 * <h2>Can be split from the API pod via {@code app.worker.enabled}</h2>
 * Originally the renderer lived in the same pod as the API, so <b>every deploy killed the jobs being rendered</b>
 * ("Worker restarted while this job was rendering"), which happened often with frequent deploys.
 *
 * <p>This flag lets one image run in two roles without splitting the project:
 * <ul>
 *   <li>{@code reportstudio-api}    - {@code APP_WORKER_ENABLED=false}: HTTP only, safe to deploy often</li>
 *   <li>{@code reportstudio-worker} - default (true): consumes the queue only, deploy when needed</li>
 * </ul>
 * Only pods with the worker enabled poll the queue. Any number of them can run side by side (e.g. during
 * a rolling update) without duplicate work, because claiming is atomic in the database.
 *
 * <p>The default is {@code true} so existing deployments without the env var behave exactly as before.
 */
@Component
@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(
        name = "app.worker.enabled", havingValue = "true", matchIfMissing = true)
public class RenderWorker {

    private static final Logger log = LoggerFactory.getLogger(RenderWorker.class);

    /** Hard ceiling per render unit — prevents a runaway JDBC query from holding a render slot forever.
     *  Override with APP_RENDER_JOB_TIMEOUT_MINUTES env (e.g. fetch engine's preGenerate→poll-until-Success
     *  flow can legitimately need up to 60 min when the document-bundle build is slow). */
    @org.springframework.beans.factory.annotation.Value("${app.render.job-timeout-minutes:20}")
    private long renderTimeoutMinutes;

    private static final ExecutorService renderExecutor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "render-worker");
        t.setDaemon(true);
        return t;
    });

    /** How many jobs may render concurrently. Sized to stay within the Hikari pool (max 10).
     *  Override with APP_RENDER_CONCURRENCY. */
    @org.springframework.beans.factory.annotation.Value("${app.render.concurrency:4}")
    private int concurrency;

    /** A running job whose heartbeat is older than this was left behind by a dead worker. */
    @org.springframework.beans.factory.annotation.Value("${app.queue.stale-after-ms:120000}")
    private long staleAfterMs;

    /** Identifies this worker instance in {@code job.claimed_by} (pod hostname + random suffix). */
    private final String workerId = hostName() + "-" + UUID.randomUUID().toString().substring(0, 8);

    /** Jobs claimed by this worker and not finished yet — the source of truth for free slots. */
    private final Set<String> inFlight = ConcurrentHashMap.newKeySet();

    /** Set on shutdown: stop claiming, let in-flight jobs finish. */
    private volatile boolean stopping = false;

    /**
     * Fixed pool of {@code concurrency} render slots. The poller only claims as many jobs as there are
     * free slots, so jobs never pile up in memory — they stay in the database (visible, cancellable,
     * claimable by another worker) until a slot is actually free.
     */
    private ThreadPoolExecutor dispatchExecutor;

    @PostConstruct
    void initDispatch() {
        dispatchExecutor = new ThreadPoolExecutor(
                concurrency, concurrency, 0L, TimeUnit.MILLISECONDS,
                new LinkedBlockingQueue<>(),
                r -> { Thread t = new Thread(r, "render-dispatch"); t.setDaemon(true); return t; });
    }

    /**
     * Wait for in-flight renders to finish before letting the JVM shut down.
     *
     * Without this method the pod shuts down in ~2 seconds and every running job dies, because
     *      1) the threads in this pool are daemons and do not keep the JVM alive
     *      2) Spring's {@code server.shutdown=graceful} only covers Tomcat's HTTP requests,
     *         not executors the app creates itself
     * so a long terminationGracePeriodSeconds was never actually used.
     *
     * Observed: a deploy during a render made the old pod disappear within a minute
     * and the job failed with "Worker restarted while this job was rendering",
     * even with separate pods, a longer grace period and the PID 1 fix in place.
     *
     * The wait is capped by {@code app.render.job-timeout-minutes} - a job past its own limit
     * has no reason to be waited for, and k8s will SIGKILL at the end of the grace period anyway.
     */
    @jakarta.annotation.PreDestroy
    void drainBeforeShutdown() {
        stopping = true;                      // stop claiming from the queue
        if (dispatchExecutor == null) return;
        int inFlight = dispatchExecutor.getActiveCount() + dispatchExecutor.getQueue().size();
        dispatchExecutor.shutdown();          // stop accepting new jobs, let queued ones finish
        if (inFlight == 0) return;
        log.info("Shutdown: waiting for {} in-flight jobs to finish (limit {} min)", inFlight, renderTimeoutMinutes);
        try {
            if (!dispatchExecutor.awaitTermination(renderTimeoutMinutes, TimeUnit.MINUTES)) {
                log.warn("Shutdown: jobs still running after {} min - letting them be cut off", renderTimeoutMinutes);
            } else {
                log.info("Shutdown: all in-flight jobs finished");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Live snapshot of the render pool for the Queue Monitor: {@code active} = jobs rendering right
     *  now, {@code queued} = jobs waiting for a free worker, {@code concurrency} = configured pool size. */
    public WorkerSnapshot workerSnapshot() {
        return new WorkerSnapshot(concurrency, inFlight.size(), dispatchExecutor.getQueue().size());
    }

    public record WorkerSnapshot(int concurrency, int active, int queued) {}

    private final JobRepository jobs;
    private final OutputFileRepository outputFiles;
    private final EngineResolver engineResolver;
    private final ObjectStorageService storage;
    private final ObjectMapper mapper;
    private final ReportUnitRepository units;
    private final ReportUnitFileRepository unitFiles;
    private final io.reporthub.reportstudio.repo.ReportRepository reports;
    private final io.reporthub.reportstudio.repo.ReportCategoryRepository categories;
    private final JobLogAppender jobLog;
    private final io.reporthub.reportstudio.render.JobCancelRegistry cancelRegistry;
    private final JobQueue queue;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.integration.FileHubService fileHub;

    public RenderWorker(JobRepository jobs,
                        OutputFileRepository outputFiles,
                        EngineResolver engineResolver,
                        ObjectStorageService storage,
                        ObjectMapper objectMapper,
                        ReportUnitRepository units,
                        ReportUnitFileRepository unitFiles,
                        io.reporthub.reportstudio.repo.ReportRepository reports,
                        io.reporthub.reportstudio.repo.ReportCategoryRepository categories,
                        JobLogAppender jobLog,
                        io.reporthub.reportstudio.render.JobCancelRegistry cancelRegistry,
                        JobQueue queue) {
        this.jobs = jobs;
        this.outputFiles = outputFiles;
        this.engineResolver = engineResolver;
        this.storage = storage;
        this.mapper = objectMapper;
        this.units = units;
        this.unitFiles = unitFiles;
        this.reports = reports;
        this.categories = categories;
        this.jobLog = jobLog;
        this.cancelRegistry = cancelRegistry;
        this.queue = queue;
    }

    /**
     * Claim as many queued jobs as there are free render slots and dispatch them. Runs on the shared
     * scheduler thread and returns immediately; rendering happens on the dispatch pool.
     */
    @Scheduled(fixedDelayString = "${app.queue.poll-ms:1000}", initialDelayString = "${app.queue.initial-delay-ms:5000}")
    public void pollQueue() {
        if (stopping) return;
        int free = concurrency - inFlight.size();
        if (free <= 0) return;
        List<JobQueue.ClaimedJob> claimed;
        try {
            claimed = queue.claim(workerId, free);
        } catch (Exception e) {
            log.warn("Queue poll failed (database unreachable?): {}", e.toString());
            return;
        }
        for (JobQueue.ClaimedJob c : claimed) {
            JobMessage msg;
            try {
                msg = toMessage(c);
            } catch (Exception e) {
                log.error("Job {} has an unreadable payload; failing it", c.id(), e);
                failUnreadable(c.id(), e);
                continue;
            }
            inFlight.add(c.id());
            try {
                dispatchExecutor.execute(() -> {
                    try {
                        processScoped(msg);
                    } finally {
                        inFlight.remove(c.id());
                    }
                });
            } catch (java.util.concurrent.RejectedExecutionException e) {
                // Shutting down between claim and dispatch: hand the job back to the queue.
                inFlight.remove(c.id());
                requeueUnstarted(c.id());
            }
        }
    }

    /** Keep the heartbeat of this worker's in-flight jobs fresh so the sweeper leaves them alone. */
    @Scheduled(fixedDelayString = "${app.queue.heartbeat-ms:15000}")
    public void heartbeat() {
        try {
            queue.heartbeat(workerId, List.copyOf(inFlight));
        } catch (Exception e) {
            log.warn("Heartbeat for {} in-flight job(s) failed: {}", inFlight.size(), e.toString());
        }
    }

    /** Build the render envelope from a claimed row; rows enqueued before the payload column fall back to the row. */
    JobMessage toMessage(JobQueue.ClaimedJob c) throws Exception {
        if (c.payload() != null && !c.payload().isBlank()) {
            JobMessage m = mapper.readValue(c.payload(), JobMessage.class);
            return new JobMessage(c.id(), m.reportCode(), m.name(), m.engine(), m.format(), m.params(),
                    m.sqlStatement(), m.datasourceId(), m.requestedBy(), c.callerToken());
        }
        Job j = jobs.findById(c.id()).orElseThrow();
        String engine = reports.findByCode(j.getReportCode()).map(r -> r.getEngine()).orElse("jasper");
        return new JobMessage(j.getId(), j.getReportCode(), j.getReportName(), engine, j.getFmt(),
                Map.of(), null, j.getDatasourceId(), j.getRequestedBy(), c.callerToken());
    }

    private void failUnreadable(String jobId, Exception e) {
        try {
            jobs.findById(jobId).ifPresent(j -> {
                j.setState("error");
                j.setErrorMessage(truncate("Unreadable job payload: " + e, 500));
                jobs.save(j);
            });
        } catch (Exception ex) {
            log.warn("Could not mark job {} as error: {}", jobId, ex.toString());
        }
    }

    private void requeueUnstarted(String jobId) {
        try {
            jobs.findById(jobId).ifPresent(j -> {
                if (!"running".equals(j.getState())) return;
                j.setState("queued");
                j.setStage("queue");
                j.setProgress(0);
                j.setClaimedBy(null);
                j.setClaimedAt(null);
                jobs.save(j);
            });
        } catch (Exception ex) {
            log.warn("Could not hand job {} back to the queue: {}", jobId, ex.toString());
        }
    }

    private static String hostName() {
        String h = System.getenv("HOSTNAME");
        if (h != null && !h.isBlank()) return h;
        try {
            return java.net.InetAddress.getLocalHost().getHostName();
        } catch (Exception e) {
            return "worker";
        }
    }

    /**
     * Run one render job end-to-end. Wrapped in its own transaction so the terminal job state
     * (done or error) is committed even though intermediate progress updates are persisted as we go.
     */
    @Transactional
    /**
     * Run {@link #process} inside the job's tenant/project and as the principal that submitted it,
     * so repository reads stay in scope and row filters match what the user would see on screen.
     */
    void processScoped(JobMessage msg) {
        io.reporthub.reportstudio.tenancy.TenantContext.Scope scope = null;
        io.reporthub.reportstudio.iam.RhPrincipal who = null;
        try {
            Job j = io.reporthub.reportstudio.tenancy.TenantContext.callAs(null,
                    () -> jobs.findById(msg.jobId()).orElse(null));
            if (j != null) {
                scope = io.reporthub.reportstudio.tenancy.TenantContext.of(j.getTenantId(), j.getProjectId());
                if (j.getPrincipalJson() != null && !j.getPrincipalJson().isBlank()) {
                    who = mapper.readValue(j.getPrincipalJson(), io.reporthub.reportstudio.iam.RhPrincipal.class);
                }
            }
        } catch (Exception e) {
            log.warn("Job {}: could not read its scope/principal ({}); running unscoped", msg.jobId(), e.toString());
        }
        if (scope == null) { process(msg); return; }
        io.reporthub.reportstudio.iam.RhPrincipal runAs = who;
        io.reporthub.reportstudio.tenancy.TenantContext.runAs(scope, () -> {
            if (runAs == null) process(msg);
            else io.reporthub.reportstudio.iam.CurrentPrincipal.runAs(runAs, () -> process(msg));
        });
    }

    /** Level-3 row filters for report SQL; optional so tests can build the worker without it. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.rowfilter.RowFilterService rowFilters;

    public void process(JobMessage msg) {
        String jobId = msg.jobId();
        // Capture every log line emitted (on any thread) during this job, correlated by MDC jobId,
        // so a failure can be downloaded/copied from the UI instead of dug out of the cluster.
        MDC.put(JobLogAppender.MDC_JOB_ID, jobId);
        jobLog.begin(jobId);
        Job job = null;
        try {
        Optional<Job> found = findWithRetry(jobId);
        if (found.isEmpty()) {
            log.warn("Received message for unknown job {} after retries; ignoring", jobId);
            return;
        }
        job = found.get();

        // GUARD: the claim flipped this job to "running" for this worker. If RunController.cancel()
        // moved it to a terminal state (state="error") between the claim and now, do NOT render it.
        if (!"running".equals(job.getState())) {
            log.info("Skipping job {} — state is '{}' (cancelled after claim), not rendering",
                    jobId, job.getState());
            return;
        }

        try {
            // worker stage
            job.setState("running");
            job.setStage("worker");
            job.setProgress(10);
            jobs.save(job);

            // jasper stage — one report may hold several render units (each with its own
            // engine, format and uploaded templates); a single run executes them ALL.
            job.setStage(stageFor(msg.engine()));
            job.setProgress(30);
            jobs.save(job);

            List<ReportUnit> unitList =
                    units.findByReportCodeAndEnabledTrueOrderBySortOrderAscIdAsc(msg.reportCode());

            int produced = 0;
            if (unitList.isEmpty()) {
                // Legacy single-engine path (no units configured).
                renderAndStore(job, msg, msg.engine(), msg.format(), null, null, null);
                produced = 1;
            } else {
                int i = 0;
                for (ReportUnit unit : unitList) {
                    // Format-pinned units render only for their own format, so one report can carry a
                    // PDF template AND an XLSX template (each pinned) and a run produces just the requested
                    // one — the "download newest output" path then always lands the right file. Units with
                    // no pinned format (the common case) always render, so existing reports are unchanged.
                    String unitFmt = unit.getFmt();
                    boolean pinned = unitFmt != null && !unitFmt.isBlank();
                    if (pinned && !unitFmt.equalsIgnoreCase(msg.format())) {
                        i++;   // keep progress denominator honest across skipped units
                        continue;
                    }
                    String fmt = pinned ? unitFmt : msg.format();
                    String templateKey = null;
                    Map<String, String> subreports = new LinkedHashMap<>();
                    for (ReportUnitFile f : unitFiles.findByUnitIdAndActiveTrueOrderByRoleAscUploadedAtAsc(unit.getId())) {
                        if ("main".equals(f.getRole())) {
                            templateKey = f.getObjectKey();
                        } else if ("subreport".equals(f.getRole()) || "resource".equals(f.getRole())) {
                            String name = f.getFileName() == null ? "" : f.getFileName();
                            String lower = name.toLowerCase();
                            boolean isTemplate = lower.endsWith(".jrxml");
                            if ("subreport".equals(f.getRole()) && isTemplate) {
                                // Compiled subreport: key = basename, exposed as $P{basename} + {basename}.jasper.
                                String base = name.contains(".")
                                        ? name.substring(0, name.lastIndexOf('.')) : name;
                                subreports.put(base, f.getObjectKey());
                            } else {
                                // Resource (logo/image/font/etc.) — uploaded as role "resource", or a
                                // non-template file filed under "subreport". Keep the FULL filename so the
                                // renderer drops it into SUBREPORT_DIR as-is (e.g. logo.png), never compiled.
                                subreports.put(name, f.getObjectKey());
                            }
                        }
                    }
                    String unitSql = sqlFromConfig(unit.getConfigJson());
                    renderAndStore(job, msg, unit.getEngine(), fmt, unit.getName(), templateKey,
                            subreports.isEmpty() ? null : subreports,
                            unit.getDatasourceId() != null ? unit.getDatasourceId() : msg.datasourceId(),
                            unitSql, unit.getConfigJson());
                    produced++;
                    job.setProgress(30 + (int) (60.0 * (++i) / unitList.size()));
                    jobs.save(job);
                }
            }

            // A report whose units are ALL format-pinned to other formats produces nothing for this run —
            // surface that as a clear error instead of a silent "done" with no downloadable output.
            if (produced == 0) {
                throw new RuntimeException("No render unit matches the requested format '"
                        + msg.format() + "' for " + msg.reportCode());
            }

            if (cancelledMeanwhile(jobId)) {
                log.info("Job {} was cancelled while rendering; not marking it done", jobId);
                return;
            }
            // done
            job.setState("done");
            job.setStage("store");
            job.setProgress(100);
            jobs.save(job);

            // Registry run counters - previously set to 0 when the report was created (ReportService) and
            // never written anywhere else, so the Report Registry showed "0 runs / 0 ms" for every report,
            // even ones that had run successfully hundreds of times.
            bumpReportCounters(msg.reportCode(), job.getStartedAt());

            log.info("Job {} produced {} artifact(s)", jobId, produced);
        } catch (Exception e) {
            if (cancelledMeanwhile(jobId)) {
                // The cancel aborted the in-flight statement; keep the user's "Cancelled ..." reason.
                log.info("Job {} stopped after cancel: {}", jobId, e.toString());
                job.setState("cancelled");
                return;
            }
            log.error("Job {} failed during render/store", jobId, e);
            try {
                job.setState("error");
                job.setErrorMessage(truncate(failureSummary(e), 500));
                jobs.save(job);
            } catch (Exception saveEx) {
                log.error("Failed to mark job {} as error", jobId, saveEx);
            }
        }
        } finally {
            // Persist the captured run log (only meaningful on failure), then ALWAYS drain + clear MDC
            // so the per-job buffer never leaks.
            String logText = jobLog.drain(jobId);
            if (job != null && "error".equals(job.getState()) && logText != null) {
                try {
                    job.setErrorDetail(truncate(logText, 256_000));
                    jobs.save(job);
                } catch (Exception persistEx) {
                    log.warn("Could not persist captured log for job {}: {}", jobId, persistEx.toString());
                }
            }
            MDC.remove(JobLogAppender.MDC_JOB_ID);
        }
    }

    /** Engines whose PDFs do not pass through ReportRenderer's watermark step. */
    static final java.util.Set<String> SELF_RENDERING_PDF_ENGINES = java.util.Set.of("fetch", "docbuilder");

    /** Stamp WATERMARK_TEXT on PDFs produced by engines that bypass the renderer's own stamping. */
    static RenderResult watermarkIfNeeded(String engine, RenderResult r, Map<String, Object> params) {
        String text = io.reporthub.reportstudio.render.PdfWatermark.textOf(params);
        if (r == null || text == null || text.isBlank() || (r.bytes() == null && r.filePath() == null) || engine == null
                || !SELF_RENDERING_PDF_ENGINES.contains(engine.toLowerCase(java.util.Locale.ROOT))) {
            return r;
        }
        boolean pdf = (r.contentType() != null && r.contentType().toLowerCase().contains("pdf"))
                || "pdf".equalsIgnoreCase(r.extension());
        if (!pdf) return r;
        if (r.bytes() == null) {
            // file-backed result (large fetch/docbuilder PDFs): stamp the file in place
            try {
                byte[] out = io.reporthub.reportstudio.render.PdfWatermark.stamp(java.nio.file.Files.readAllBytes(r.filePath()), text);
                java.nio.file.Files.write(r.filePath(), out);
                return RenderResult.ofFile(r.filePath(), r.contentType(), r.extension(), out.length);
            } catch (java.io.IOException e) {
                throw new java.io.UncheckedIOException("Could not watermark " + r.filePath().getFileName(), e);
            }
        }
        byte[] out = io.reporthub.reportstudio.render.PdfWatermark.stamp(r.bytes(), text);
        return new RenderResult(out, r.contentType(), r.extension(), out.length);
    }

    /** True when the job row was moved to "cancelled" (by the cancel endpoint) after this worker claimed it. */
    private boolean cancelledMeanwhile(String jobId) {
        try {
            return jobs.findStateById(jobId).map("cancelled"::equals).orElse(false);
        } catch (Exception e) {
            return false;
        }
    }

    /** Stage shown while rendering = the engine actually doing the work. */
    static String stageFor(String engine) {
        if (engine == null || engine.isBlank()) return "render";
        String e = engine.trim().toLowerCase();
        return e.length() > 32 ? e.substring(0, 32) : e;
    }

    /**
     * Fail any job still marked "running" whose worker is gone — its render thread died with that
     * pod, so nothing will ever finish it or write its terminal state. Runs at startup and then every
     * {@code app.queue.sweep-ms}. Left alone these rows sit in
     * the Queue Monitor as "running 30%" forever and count against the pool's apparent capacity;
     * One environment had accumulated ten of them, the oldest two months old, before this existed.
     *
     * <p>Queued jobs need no recovery: they simply stay in the table until a worker claims them.
     *
     * <p>A running job is NOT re-queued: a half-rendered job may already have stored
     * output, and re-running it unattended could double-charge an expensive query. The user can
     * hit Retry.
     *
     * <p>Previously this swept <b>every</b> job in state {@code running}, assuming a single pod
     * (the old comment warned "with more than one, a booting pod would fail jobs its
     * siblings are legitimately rendering") - that assumption <b>no longer holds</b>,
     * because the worker is its own Deployment using a RollingUpdate strategy (maxUnavailable 0),
     * so a new pod boots <b>while the old pod is still rendering</b> and sweeps its sibling's jobs.
     *
     * Observed: a job was set to error within 30 seconds of a rollout restart
     * while the old pod was still Terminating and still rendering,
     * so part of the "jobs die on every deploy" symptom was caused by <b>this sweeper itself</b>.
     *
     * <p>Fix: every live worker heartbeats its jobs ({@code heartbeat_at}), so a job is orphaned only when its
     * heartbeat is older than {@code app.queue.stale-after-ms} — a sibling pod that is still rendering keeps
     * its jobs fresh and is never swept. Rows without a heartbeat (claimed before heartbeats existed) fall
     * back to the old rule: older than the job time limit.
     */
    @EventListener(ApplicationReadyEvent.class)
    @Scheduled(fixedDelayString = "${app.queue.sweep-ms:60000}", initialDelayString = "${app.queue.sweep-ms:60000}")
    @Transactional
    public void failOrphanedRunningJobs() {
        OffsetDateTime now = OffsetDateTime.now();
        OffsetDateTime staleHeartbeat = now.minus(java.time.Duration.ofMillis(staleAfterMs));
        OffsetDateTime legacyCutoff = now.minusMinutes(renderTimeoutMinutes);
        List<Job> orphaned = jobs.findByState("running").stream()
                .filter(j -> !inFlight.contains(j.getId()))   // ours and alive, whatever the clock says
                .filter(j -> j.getHeartbeatAt() != null
                        ? j.getHeartbeatAt().isBefore(staleHeartbeat)
                        // no heartbeat: within its own limit = may be running on another pod, do not touch
                        : (j.getStartedAt() == null || j.getStartedAt().isBefore(legacyCutoff)))
                .toList();
        if (orphaned.isEmpty()) return;
        log.info("Failing {} orphaned running job(s) whose worker stopped heartbeating", orphaned.size());
        for (Job j : orphaned) {
            j.setState("error");
            j.setErrorMessage("Worker restarted while this job was rendering — no result was produced");
            jobs.save(j);
            log.info("Marked orphaned job {} ({}) as error", j.getId(), j.getReportCode());
        }
    }

    /**
     * Retry DB lookup up to 3 times with short back-off. Claimed rows are always committed, so this is
     * only a safety net against transient read failures.
     */
    private Optional<Job> findWithRetry(String jobId) {
        long[] delaysMs = {0, 200, 600};
        for (long delay : delaysMs) {
            if (delay > 0) {
                try { TimeUnit.MILLISECONDS.sleep(delay); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            }
            Optional<Job> found = jobs.findById(jobId);
            if (found.isPresent()) return found;
        }
        return Optional.empty();
    }

    /** Render one unit (or the legacy single pass) and persist its artifact + OutputFile row. */
    private void renderAndStore(Job job, JobMessage msg, String engine, String format,
                                String unitName, String templateKey,
                                Map<String, String> subreports) {
        renderAndStore(job, msg, engine, format, unitName, templateKey, subreports, msg.datasourceId(),
                msg.sqlStatement(), null);
    }

    /**
     * The run's parameters plus {@code USER} — the username that submitted the run.
     *
     * <p>Some reports call a stored procedure that writes its rows into a shared staging table and
     * then reads them back with {@code WHERE CREATED_BY = P_USER}. With {@code USER} unset that predicate
     * is {@code null = null}, so the procedure wrote its rows and handed back an empty cursor — a
     * report that renders "successfully" with nothing but headers. Passing the requester also keeps
     * two people running the same report from clearing each other's rows mid-render.
     *
     * <p>A parameter the run already carries wins, so a template that declares its own {@code USER}
     * is untouched.
     */
    private Map<String, Object> withRequestingUser(JobMessage msg) {
        String user = msg.requestedBy();
        if (user == null || user.isBlank()) return msg.params();
        Map<String, Object> params = msg.params() == null
                ? new LinkedHashMap<>() : new LinkedHashMap<>(msg.params());
        params.putIfAbsent("USER", user);
        return params;
    }

    private void renderAndStore(Job job, JobMessage msg, String engine, String format,
                                String unitName, String templateKey,
                                Map<String, String> subreports, String datasourceId, String sqlStatement,
                                String configJson) {
        Map<String, Object> renderParams = withRequestingUser(msg);
        String sql = (sqlStatement != null && !sqlStatement.isBlank()) ? sqlStatement : msg.sqlStatement();
        if (rowFilters != null && sql != null && !sql.isBlank()) {
            Map<String, Object> p = renderParams == null ? new LinkedHashMap<>() : new LinkedHashMap<>(renderParams);
            String wrapped = rowFilters.wrapForRender(msg.reportCode(), sql, p);
            if (!wrapped.equals(sql)) { sql = wrapped; renderParams = p; }
        }
        RenderRequest req = new RenderRequest(
                msg.reportCode(),
                msg.name(),
                engine,
                format,
                renderParams,
                sql,
                datasourceId,
                templateKey,
                subreports,
                configJson,
                msg.callerToken());
        RenderResult result = renderWithTimeout(req);
        result = watermarkIfNeeded(engine, result, renderParams);

        String ext = (result.extension() == null || result.extension().isBlank())
                ? format.toLowerCase()
                : result.extension();
        String unitPart = unitName == null ? "" : "_" + unitName.replaceAll("[^\\p{L}\\p{N}_-]", "_");
        String folder = resolveFolder(msg.reportCode(), unitName, format);
        // Gotcha: object keys must be pure ASCII - MinIO rejects object names with non-Latin characters
        //    ("Object name contains unsupported characters"), so a non-ASCII report name only appears in
        //    Content-Disposition at download time (OutputController.downloadFilename)
        // Gotcha: the uniqueness suffix must be the jobId, not System.currentTimeMillis() - two jobs of the same report
        //    storing a file in the same millisecond would get the same key and fail on output_file_object_key_key
        //    (this has happened in practice).
        String objectKey = folder + "/" + msg.reportCode() + unitPart + "_"
                + msg.jobId() + "_" + System.currentTimeMillis() + "." + ext;

        // File-backed results (large query-exports) stream straight from disk; small ones go via byte[].
        StoredObjectMeta meta;
        if (result.filePath() != null) {
            try {
                meta = storage.put(objectKey, result.filePath(), result.contentType());
            } finally {
                try { java.nio.file.Files.deleteIfExists(result.filePath()); } catch (Exception ignore) { }
            }
        } else {
            meta = storage.put(objectKey, result.bytes(), result.contentType());
        }

        OutputFile out = new OutputFile();
        out.setObjectKey(meta.objectKey());
        out.setReportCode(msg.reportCode());
        out.setJobId(job.getId());
        out.setFmt(format != null ? format.toUpperCase() : ext.toUpperCase());
        out.setSizeBytes(meta.sizeBytes());
        out.setCreatedBy(msg.requestedBy());
        try {
            Map<String, Object> p = msg.params();
            out.setParams(p == null || p.isEmpty() ? null : mapper.writeValueAsString(p));
        } catch (Exception e) {
            // Never fail a render just because params couldn't be serialized for history.
            log.warn("Could not serialize params for output of job {}: {}", job.getId(), e.toString());
        }
        out.setCreatedAt(OffsetDateTime.now());
        outputFiles.save(out);

        // Optional per-report "Deliver to FileHub": a failure is a warning on the job, never a failed render.
        if (fileHub != null) {
            String warning = fileHub.deliverAfterRender(job, out, objectKey.substring(objectKey.lastIndexOf('/') + 1),
                    result.contentType());
            if (warning != null) job.setWarning(job.getWarning() == null ? warning : job.getWarning() + "\n" + warning);
        }

        log.info("Job {} unit '{}' rendered to {} ({} bytes)",
                job.getId(), unitName == null ? "-" : unitName, objectKey, meta.sizeBytes());
    }

    /**
     * Run the engine render in a daemon thread so a render slot is never held
     * beyond {@link #renderTimeoutMinutes}. A timed-out render is interrupted (best-effort
     * for JDBC queries) and the job is marked {@code error} by the caller's catch block.
     */
    private RenderResult renderWithTimeout(RenderRequest req) {
        // Propagate the MDC (jobId) onto the render thread so Jasper/JDBC logs emitted there are
        // captured into this job's log buffer too, not just the ones on the dispatch thread.
        Map<String, String> mdc = MDC.getCopyOfContextMap();
        String jobId = MDC.get(JobLogAppender.MDC_JOB_ID);
        // Open the cancel slot BEFORE submitting: the render thread reaches openConnection almost
        // immediately, and a connection opened before the slot exists would never be tracked.
        // Without this a "cancel" only relabels the row while the query keeps burning a worker
        // slot and a DB session.
        cancelRegistry.register(jobId);
        // The engine runs on a pool thread: hand it the job's scope and principal, so engines that
        // call back into ReportHub (the built-in document exporter) act as the submitting user.
        io.reporthub.reportstudio.tenancy.TenantContext.Scope scope =
                io.reporthub.reportstudio.tenancy.TenantContext.current().orElse(null);
        io.reporthub.reportstudio.iam.RhPrincipal who =
                io.reporthub.reportstudio.iam.CurrentPrincipal.get().orElse(null);
        Future<RenderResult> future = renderExecutor.submit(() -> {
            if (mdc != null) MDC.setContextMap(mdc);
            io.reporthub.reportstudio.tenancy.TenantContext.set(scope);
            try {
                return io.reporthub.reportstudio.iam.CurrentPrincipal.callAs(who, () -> engineResolver.render(req));
            } finally {
                io.reporthub.reportstudio.tenancy.TenantContext.clear();
                MDC.clear();
            }
        });
        cancelRegistry.attach(jobId, future);
        long limit = reports.findByCode(req.code()).map(r -> r.getTimeoutMinutes())
                .filter(t -> t != null && t > 0).map(Integer::longValue).orElse(renderTimeoutMinutes);
        try {
            return future.get(limit, TimeUnit.MINUTES);
        } catch (TimeoutException e) {
            cancelRegistry.cancel(jobId);
            throw new RuntimeException(
                    "Render timed out after " + limit + " min: " + req.code(), e);
        } catch (Exception e) {
            cancelRegistry.cancel(jobId);
            throw new RuntimeException("Render failed: " + req.code(), e);
        } finally {
            cancelRegistry.done(jobId);
        }
    }

    /** One-line failure summary = wrapper message + the deepest cause (e.g. an ORA-xxxxx). */
    private static String failureSummary(Throwable e) {
        String top = e.getMessage();
        String root = rootCauseMessage(e);
        if (root == null || root.equals(top)) return top;
        return (top == null ? "" : top + " — ") + root;
    }

    private static String rootCauseMessage(Throwable t) {
        Throwable c = t;
        while (c.getCause() != null && c.getCause() != c) c = c.getCause();
        return c.getMessage();
    }

    /**
     * Increment the successful run count and update the report's average duration on the registry.
     *
     * <p>The average is a running average - {@code (oldAvg * oldCount + latest) /
     * (oldCount + 1)}, so the full job history never has to be re-read.
     *
     * <p>A counter failure must not turn a successfully rendered job into an error - all exceptions are caught
     * and logged as warn, since the output file was already stored before this line.
     */
    private void bumpReportCounters(String reportCode, java.time.OffsetDateTime startedAt) {
        try {
            reports.findByCode(reportCode).ifPresent(r -> {
                int prevRuns = Math.max(r.getRuns(), 0);
                long ms = startedAt == null ? 0L
                        : Math.max(0L, java.time.Duration.between(startedAt,
                                java.time.OffsetDateTime.now()).toMillis());
                if (ms > 0L) {
                    long avg = ((long) Math.max(r.getAvgMs(), 0) * prevRuns + ms) / (prevRuns + 1);
                    r.setAvgMs((int) Math.min(avg, Integer.MAX_VALUE));
                }
                r.setRuns(prevRuns + 1);
                reports.save(r);
            });
        } catch (Exception e) {
            log.warn("Could not update run counters for report {}", reportCode, e);
        }
    }

    private static String truncate(String s, int max) {
        if (s == null) return null;
        return s.length() <= max ? s : s.substring(0, max) + "\n… (truncated)";
    }

    /** Pull the SQL statement out of a render unit's config JSON ({@code {"sql": "..."}}). */
    private String sqlFromConfig(String configJson) {
        if (configJson == null || configJson.isBlank()) return null;
        try {
            var node = mapper.readTree(configJson);
            if (node.hasNonNull("sql")) {
                String sql = node.get("sql").asText();
                return (sql == null || sql.isBlank()) ? null : sql;
            }
        } catch (Exception ignore) {
            // not JSON / no sql key — treat as no statement
        }
        return null;
    }

    /**
     * Resolve the report's output-folder pattern. Placeholders: {code} {category} {unit}
     * {fmt} {yyyy} {MM} {dd}. Default (no pattern) = the report code. Each segment is
     * sanitized so patterns can never escape the bucket layout.
     */

    private String resolveFolder(String reportCode, String unitName, String format) {
        String pattern = reports.findByCode(reportCode)
                .map(r -> {
                    String p = r.getOutputFolder();
                    if (p == null || p.isBlank()) return "{code}";
                    return p;
                }).orElse("{code}");
        String category = reports.findByCode(reportCode)
                .flatMap(r -> categories.findById(r.getCategoryId()))
                .map(c -> c.getName()).orElse("uncategorized");
        java.time.LocalDate today = java.time.LocalDate.now();
        String resolved = pattern
                .replace("{code}", reportCode)
                .replace("{category}", category)
                .replace("{unit}", unitName == null ? "default" : unitName)
                .replace("{fmt}", format == null ? "out" : format.toLowerCase())
                .replace("{yyyy}", String.format("%04d", today.getYear()))
                .replace("{MM}", String.format("%02d", today.getMonthValue()))
                .replace("{dd}", String.format("%02d", today.getDayOfMonth()));
        StringBuilder safe = new StringBuilder();
        for (String seg : resolved.split("/")) {
            String cleaned = seg.trim().replaceAll("[^\\p{L}\\p{M}\\p{N} ._-]", "_");
            if (cleaned.isBlank() || cleaned.equals(".") || cleaned.equals("..")) continue;
            if (safe.length() > 0) safe.append("/");
            safe.append(cleaned);
        }
        return safe.length() == 0 ? reportCode : safe.toString();
    }
}
