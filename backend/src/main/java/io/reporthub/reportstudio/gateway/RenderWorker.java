package io.reporthub.reportstudio.gateway;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.kafka.annotation.KafkaListener;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Kafka consumer that performs the actual render → store pipeline for queued jobs.
 *
 * <p>Lifecycle per message: parse the {@link JobMessage}, move the job to
 * {@code running}/stage {@code worker}, then stage {@code jasper}, invoke {@link ReportRenderer},
 * persist the bytes through {@link ObjectStorageService}, record an {@link OutputFile} row, and
 * finish at stage {@code store} / state {@code done} / progress {@code 100}. Any failure flips the
 * job to state {@code error}.
 *
 * <p>The listener uses the {@code kafkaListenerContainerFactory} configured with
 * {@code missing-topics-fatal=false}, so a missing topic or unreachable broker never aborts
 * application startup.
 */
@Component
public class RenderWorker {

    private static final Logger log = LoggerFactory.getLogger(RenderWorker.class);

    /** Hard ceiling per render unit — prevents a runaway JDBC query from blocking the consumer forever.
     *  Override with APP_RENDER_JOB_TIMEOUT_MINUTES env (e.g. fetch engine's preGenerate→poll-until-Success
     *  flow can legitimately need up to 60 min when the document-bundle build is slow). */
    @org.springframework.beans.factory.annotation.Value("${app.render.job-timeout-minutes:20}")
    private long renderTimeoutMinutes;

    private static final ExecutorService renderExecutor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "render-worker");
        t.setDaemon(true);
        return t;
    });

    private final JobRepository jobs;
    private final OutputFileRepository outputFiles;
    private final EngineResolver engineResolver;
    private final ObjectStorageService storage;
    private final ObjectMapper mapper;
    private final ReportUnitRepository units;
    private final ReportUnitFileRepository unitFiles;
    private final io.reporthub.reportstudio.repo.ReportRepository reports;
    private final io.reporthub.reportstudio.repo.ReportCategoryRepository categories;
    private final JobGateway gateway;

    public RenderWorker(JobRepository jobs,
                        OutputFileRepository outputFiles,
                        EngineResolver engineResolver,
                        ObjectStorageService storage,
                        ObjectMapper kafkaObjectMapper,
                        ReportUnitRepository units,
                        ReportUnitFileRepository unitFiles,
                        io.reporthub.reportstudio.repo.ReportRepository reports,
                        io.reporthub.reportstudio.repo.ReportCategoryRepository categories,
                        JobGateway gateway) {
        this.jobs = jobs;
        this.outputFiles = outputFiles;
        this.engineResolver = engineResolver;
        this.storage = storage;
        this.mapper = kafkaObjectMapper;
        this.units = units;
        this.unitFiles = unitFiles;
        this.reports = reports;
        this.categories = categories;
        this.gateway = gateway;
    }

    @KafkaListener(
            topics = KafkaConfig.TOPIC_REPORT_JOBS,
            containerFactory = "kafkaListenerContainerFactory")
    public void onMessage(String payload) {
        JobMessage msg;
        try {
            msg = mapper.readValue(payload, JobMessage.class);
        } catch (Exception e) {
            log.error("Dropping unparseable report.jobs message: {}", payload, e);
            return;
        }
        process(msg);
    }

    /**
     * Run one render job end-to-end. Wrapped in its own transaction so the terminal job state
     * (done or error) is committed even though intermediate progress updates are persisted as we go.
     */
    @Transactional
    public void process(JobMessage msg) {
        String jobId = msg.jobId();
        Optional<Job> found = findWithRetry(jobId);
        if (found.isEmpty()) {
            log.warn("Received message for unknown job {} after retries; ignoring", jobId);
            return;
        }
        Job job = found.get();

        // GUARD: only "queued" jobs are eligible to render. If RunController.cancel() flipped this job
        // to a terminal state (state="error") after it was published/recovered but before we consumed
        // the message, do NOT render it. recoverStuckQueuedJobs() re-publishes only "queued" jobs, so
        // this never blocks legitimate recovery, and it makes duplicate Kafka deliveries idempotent.
        if (!"queued".equals(job.getState())) {
            log.info("Skipping job {} — state is '{}' (canceled or already taken), not rendering",
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
            job.setStage("jasper");
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
                    String fmt = (unit.getFmt() == null || unit.getFmt().isBlank())
                            ? msg.format() : unit.getFmt();
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
                                // renderer drops it into SUBREPORT_DIR as-is (e.g. BB_logo.png), never compiled.
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

            // done
            job.setState("done");
            job.setStage("store");
            job.setProgress(100);
            jobs.save(job);

            log.info("Job {} produced {} artifact(s)", jobId, produced);
        } catch (Exception e) {
            log.error("Job {} failed during render/store", jobId, e);
            try {
                job.setState("error");
                String errMsg = e.getMessage();
                job.setErrorMessage(errMsg != null && errMsg.length() > 500 ? errMsg.substring(0, 500) : errMsg);
                jobs.save(job);
            } catch (Exception saveEx) {
                log.error("Failed to mark job {} as error", jobId, saveEx);
            }
        }
    }

    /**
     * On startup, re-publish any jobs that are still in "queued" state — these were left behind
     * by a previous pod restart before the Kafka message was consumed. Re-publishing is idempotent
     * because the worker ignores duplicate job IDs that are no longer "queued" (the state will have
     * been updated to "running" or "done" by the time any duplicate fires).
     */
    @EventListener(ApplicationReadyEvent.class)
    @Transactional(readOnly = true)
    public void recoverStuckQueuedJobs() {
        List<Job> stuck = jobs.findAll().stream()
                .filter(j -> "queued".equals(j.getState()))
                .toList();
        if (stuck.isEmpty()) return;
        log.info("Recovering {} stuck queued job(s) after startup", stuck.size());
        for (Job j : stuck) {
            try {
                var report = reports.findByCode(j.getReportCode()).orElse(null);
                String engine = report != null ? report.getEngine() : "jasper";
                JobMessage msg = new JobMessage(
                        j.getId(), j.getReportCode(), j.getReportName(),
                        engine, j.getFmt(), Map.of(), null,
                        j.getDatasourceId(), j.getRequestedBy());
                gateway.publish(j.getId(), msg);
                log.info("Re-published stuck job {}", j.getId());
            } catch (Exception e) {
                log.warn("Could not re-publish stuck job {}: {}", j.getId(), e.toString());
            }
        }
    }

    /**
     * Retry DB lookup up to 3 times with short back-off. Safety net for the (now-fixed)
     * race window where the Kafka message could arrive before the DB transaction committed.
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

    private void renderAndStore(Job job, JobMessage msg, String engine, String format,
                                String unitName, String templateKey,
                                Map<String, String> subreports, String datasourceId, String sqlStatement,
                                String configJson) {
        RenderRequest req = new RenderRequest(
                msg.reportCode(),
                msg.name(),
                engine,
                format,
                msg.params(),
                (sqlStatement != null && !sqlStatement.isBlank()) ? sqlStatement : msg.sqlStatement(),
                datasourceId,
                templateKey,
                subreports,
                configJson);
        RenderResult result = renderWithTimeout(req);

        String ext = (result.extension() == null || result.extension().isBlank())
                ? format.toLowerCase()
                : result.extension();
        String unitPart = unitName == null ? "" : "_" + unitName.replaceAll("[^\\p{L}\\p{N}_-]", "_");
        String folder = resolveFolder(msg.reportCode(), unitName, format);
        String objectKey = folder + "/" + msg.reportCode() + unitPart + "_" + System.currentTimeMillis() + "." + ext;

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

        log.info("Job {} unit '{}' rendered to {} ({} bytes)",
                job.getId(), unitName == null ? "-" : unitName, objectKey, meta.sizeBytes());
    }

    /**
     * Run the engine render in a daemon thread so the Kafka consumer thread is never blocked
     * beyond {@link #renderTimeoutMinutes}. A timed-out render is interrupted (best-effort
     * for JDBC queries) and the job is marked {@code error} by the caller's catch block.
     */
    private RenderResult renderWithTimeout(RenderRequest req) {
        Future<RenderResult> future = renderExecutor.submit(() -> engineResolver.render(req));
        try {
            return future.get(renderTimeoutMinutes, TimeUnit.MINUTES);
        } catch (TimeoutException e) {
            future.cancel(true);
            throw new RuntimeException(
                    "Render timed out after " + renderTimeoutMinutes + " min: " + req.code(), e);
        } catch (Exception e) {
            future.cancel(true);
            throw new RuntimeException("Render failed: " + req.code(), e);
        }
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
