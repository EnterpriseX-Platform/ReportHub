package io.reporthub.reportstudio.service;

import org.springframework.scheduling.support.CronExpression;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import io.reporthub.reportstudio.domain.WarehousePipeline;
import io.reporthub.reportstudio.domain.WarehouseRun;
import io.reporthub.reportstudio.repo.WarehousePipelineRepository;
import io.reporthub.reportstudio.repo.WarehouseRunRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Types;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Data-warehouse ETL (the "pull data from a real source into a target table" feature): run a source SELECT against any
 * datasource and load the rows into a target table on any datasource. Target is auto-created from
 * the result-set metadata when missing. Load modes: replace (truncate+insert), append (insert),
 * upsert (delete-by-key then insert — "clear by key"). Rows are streamed and batched so large
 * extracts don't buffer in memory; the whole load runs in one target-side transaction.
 */
@Service
public class WarehouseService {

    private static final Pattern IDENT = Pattern.compile("[A-Za-z_][A-Za-z0-9_$#]*");
    /**
     * One value — the year — in four-digit or two-digit form.
     *
     * <p>Source tables may store a year as four digits or as its last two digits:
     *
     * <pre>
     *   WHERE &lt;column&gt; = '$YEAR4'   -- 2026   ($YEAR is the same)
     *     AND &lt;column&gt; = '$YEAR2'   -- 26     ($YEAR:2 is the same)
     * </pre>
     */
    private static final Pattern YEAR_TOKEN =
            Pattern.compile("\\$YEAR(?::?([24]))?\\b");
    private static final int BATCH = 1000;

    public record LoadStats(int rowsRead, int rowsWritten, boolean created, List<String> addedColumns) {
        public LoadStats(int rowsRead, int rowsWritten, boolean created) {
            this(rowsRead, rowsWritten, created, List.of());
        }
    }

    private final WarehousePipelineRepository repo;
    private final WarehouseRunRepository runs;
    private final DbConnections db;
    private final TransactionTemplate tx;
    private final DatasetService datasets;

    /**
     * Manual runs happen here instead of on the request thread. A full extract can be ~200k rows;
     * holding the HTTP request open for that long means the edge times the caller out and the user
     * has no way to tell whether the load finished. One worker, so two clicks queue rather than
     * fight over the same target table.
     */
    private final ExecutorService pool =
            Executors.newSingleThreadExecutor(r -> new Thread(r, "warehouse-run"));

    private final WarehouseCancelRegistry cancels;
    private final io.reporthub.reportstudio.repo.WarehousePipelineStepRepository steps;
    private final io.reporthub.reportstudio.repo.WarehouseRunStepRepository runSteps;
    /**
     * Executor per step kind — a new kind = a new class, nothing to change here.
     *
     * <p>Must be an {@link ObjectProvider}, not a plain List: LoadStepExecutor calls back into this
     * service, so constructor injection would be circular (warehouseService -> loadStepExecutor
     * -> warehouseService) and the context would not start. The provider defers lookup to first use.
     */
    private final ObjectProvider<java.util.List<io.reporthub.reportstudio.service.etl.ChainStepExecutor>> executorProvider;
    private volatile java.util.Map<String, io.reporthub.reportstudio.service.etl.ChainStepExecutor> executorCache;

    private java.util.Map<String, io.reporthub.reportstudio.service.etl.ChainStepExecutor> executors() {
        var cached = executorCache;
        if (cached != null) return cached;
        java.util.Map<String, io.reporthub.reportstudio.service.etl.ChainStepExecutor> m = new java.util.LinkedHashMap<>();
        var list = executorProvider.getIfAvailable(java.util.List::of);
        for (var e : list) m.put(e.type(), e);
        executorCache = m;
        return m;
    }
    private final com.fasterxml.jackson.databind.ObjectMapper json =
            new com.fasterxml.jackson.databind.ObjectMapper();

    public WarehouseService(WarehousePipelineRepository repo, WarehouseRunRepository runs,
                            DbConnections db, TransactionTemplate tx, DatasetService datasets,
                            WarehouseCancelRegistry cancels,
                            io.reporthub.reportstudio.repo.WarehousePipelineStepRepository steps,
                            io.reporthub.reportstudio.repo.WarehouseRunStepRepository runSteps,
                            ObjectProvider<java.util.List<io.reporthub.reportstudio.service.etl.ChainStepExecutor>> stepExecutors) {
        this.repo = repo;
        this.runs = runs;
        this.db = db;
        this.tx = tx;
        this.datasets = datasets;
        this.cancels = cancels;
        this.steps = steps;
        this.runSteps = runSteps;
        this.executorProvider = stepExecutors;
    }

    /**
     * Latest runs of every pipeline — {@code perPipeline} runs each, newest first.
     *
     * <p>Read in one query and trimmed in Java: the whole history is a few hundred rows, and a window
     * function written for two databases (Postgres/Oracle) costs more than it saves.
     */
    @Transactional(readOnly = true)
    public java.util.List<WarehouseRun> recentRuns(int perPipeline) {
        java.util.Map<Long, Integer> seen = new java.util.HashMap<>();
        java.util.List<WarehouseRun> out = new java.util.ArrayList<>();
        for (WarehouseRun r : runs.findAll(org.springframework.data.domain.Sort.by(
                org.springframework.data.domain.Sort.Direction.DESC, "id"))) {
            int n = seen.merge(r.getPipelineId(), 1, Integer::sum);
            if (n <= perPipeline) out.add(r);
        }
        return out;
    }

    @Transactional(readOnly = true)
    public java.util.List<io.reporthub.reportstudio.domain.WarehousePipelineStep> stepsOf(Long pipelineId) {
        return steps.findByPipelineIdOrderByStepNoAsc(pipelineId);
    }

    @Transactional(readOnly = true)
    public java.util.List<io.reporthub.reportstudio.domain.WarehouseRunStep> runStepsOf(Long runId) {
        return runSteps.findByRunIdOrderByStepNoAsc(runId);
    }

    /** Step kinds offered by the editor. */
    @Transactional(readOnly = true)
    public java.util.List<java.util.Map<String, String>> stepTypes() {
        java.util.List<java.util.Map<String, String>> out = new java.util.ArrayList<>();
        for (var e : executors().values()) out.add(java.util.Map.of("type", e.type(), "label", e.label()));
        return out;
    }

    /** Replace the pipeline's whole step list — the order given is the run order. */
    @Transactional
    public void saveSteps(Long pipelineId, java.util.List<io.reporthub.reportstudio.domain.WarehousePipelineStep> plan) {
        require(pipelineId);
        steps.deleteByPipelineId(pipelineId);
        // Deletes must reach the database before the inserts: Hibernate flushes inserts first, so
        // re-saving an existing list (same pipeline_id + step_no) would hit warehouse_pipeline_step_uq.
        steps.flush();
        int n = 1;
        for (var in : plan) {
            var st = new io.reporthub.reportstudio.domain.WarehousePipelineStep();
            st.setPipelineId(pipelineId);
            st.setStepNo(n++);
            String kind = in.getKind() == null ? "" : in.getKind().trim();
            if (!executors().containsKey(kind)) {
                throw new BadRequestException("Unknown step kind: " + in.getKind());
            }
            st.setKind(kind);
            st.setLabel(blank(in.getLabel()));
            st.setConfig(blank(in.getConfig()));
            st.setOnFail("continue".equalsIgnoreCase(in.getOnFail()) ? "continue" : "stop");
            st.setVarName(blank(in.getVarName()));
            steps.save(st);
        }
    }

    @Transactional(readOnly = true)
    public List<WarehousePipeline> list() {
        return repo.findAllByOrderByCreatedAtDesc();
    }

    @Transactional(readOnly = true)
    public WarehousePipeline require(Long id) {
        return repo.findById(id).orElseThrow(() -> new NotFoundException("Pipeline not found: " + id));
    }

    @Transactional(readOnly = true)
    public List<WarehouseRun> history(Long id, int limit) {
        require(id);
        return runs.findByPipelineIdOrderByStartedAtDesc(id,
                org.springframework.data.domain.PageRequest.of(0, Math.min(Math.max(limit, 1), 200)));
    }

    @Transactional
    public WarehousePipeline save(Long id, WarehousePipeline form, String user) {
        validate(form);
        WarehousePipeline p = id == null ? new WarehousePipeline() : require(id);
        p.setName(form.getName().trim());
        p.setDescription(form.getDescription());
        p.setFolder(blank(form.getFolder()));
        p.setSourceDatasourceId(blank(form.getSourceDatasourceId()));
        p.setSourceSql(form.getSourceSql().trim());
        p.setFiscalYear(blank(form.getFiscalYear()));
        p.setTargetDatasourceId(blank(form.getTargetDatasourceId()));
        // V32 added target_schema and the controller reads it, but save() never copied it: a
        // pipeline edited through the UI silently lost its schema and wrote into the connection's
        // own default schema instead of the configured one.
        p.setTargetSchema(blank(form.getTargetSchema()));
        p.setTargetTable(form.getTargetTable().trim());
        p.setLoadMode(form.getLoadMode());
        // Three real modes: delete | truncate | partition — this code used to collapse them to two, so a
        // pipeline set to partition was downgraded to delete as soon as anyone pressed
        // Save in the UI, and clearing silently went back to taking 12 minutes.
        String cm = form.getClearMode() == null ? "" : form.getClearMode().trim().toLowerCase();
        p.setClearMode("truncate".equals(cm) ? "truncate" : "partition".equals(cm) ? "partition" : "delete");
        p.setClearWhere(blank(form.getClearWhere()));
        p.setControlColumn(blank(form.getControlColumn()));
        p.setControlTolerance(form.getControlTolerance() == null
                ? java.math.BigDecimal.ZERO : form.getControlTolerance());
        p.setParamsJson(blank(form.getParamsJson()));
        p.setKeyColumns(blank(form.getKeyColumns()));
        p.setAutoCreate(form.isAutoCreate());
        p.setAddColumns(form.isAddColumns());
        p.setCron(blank(form.getCron()));
        p.setEnabled(form.isEnabled());
        OffsetDateTime now = OffsetDateTime.now();
        if (id == null) { p.setCreatedBy(user); p.setCreatedAt(now); }
        p.setUpdatedAt(now);
        p.setNextRunAt(p.isEnabled() && p.getCron() != null ? nextFrom(p.getCron(), now) : null);
        return repo.save(p);
    }

    @Transactional
    public WarehousePipeline setEnabled(Long id, boolean enabled) {
        WarehousePipeline p = require(id);
        p.setEnabled(enabled);
        p.setUpdatedAt(OffsetDateTime.now());
        p.setNextRunAt(enabled && p.getCron() != null ? nextFrom(p.getCron(), OffsetDateTime.now()) : null);
        return repo.save(p);
    }

    @Transactional
    public void delete(Long id) {
        WarehousePipeline p = require(id);
        runs.deleteByPipelineId(id);
        repo.delete(p);
    }

    /**
     * Starts a manual run and returns immediately with a {@code running} record; the load itself
     * happens on {@link #pool}. Callers poll the run history for the outcome.
     *
     * @param year the year the caller (normally the portal) is set to; null falls back to the pipeline's own.
     */
    @Transactional
    public WarehouseRun runNow(Long id, String user, String year) {
        return runNow(id, user, year, java.util.Map.of());
    }

    /** Same, with the values the caller filled in for this pipeline's declared parameters. */
    @Transactional
    public WarehouseRun runNow(Long id, String user, String year, java.util.Map<String, String> params) {
        WarehousePipeline p = require(id);
        String y = year == null || year.isBlank() ? p.getFiscalYear() : year.trim();
        final java.util.Map<String, String> effective = withDefaults(p.getParamsJson(), params);

        WarehouseRun run = new WarehouseRun();
        run.setPipelineId(p.getId());
        run.setStartedAt(OffsetDateTime.now());
        run.setTrigger("manual");
        run.setRunBy(user);
        // The worker is single-threaded — three clicks are three queued jobs, not three running at once.
        // So status starts as "queued" and the worker moves it to "running" when it actually picks it up
        // (otherwise the screen shows three running rows and nobody can tell which one is active).
        run.setStatus("queued");
        final WarehouseRun saved = runs.save(run);

        p.setLastStatus("queued");
        p.setLastError(null);
        p.setLastRunAt(saved.getStartedAt());
        repo.save(p);

        // Hand off only once this transaction has committed — the worker loads the run by id and
        // would not see an uncommitted row.
        final Long pipelineId = p.getId();
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() {
                pool.submit(() -> work(saved.getId(), pipelineId, y, effective));
            }
        });
        return saved;
    }

    /**
     * The same load as {@link #runNow}, but on the calling thread and finished when it returns.
     *
     * <p>For a chain runner, which has to know each step's outcome before deciding whether to run
     * the next one. The async path exists so an HTTP request is not held open; a chain is already
     * running off-request on its own worker, so there is nothing to hand off to — and polling the
     * async run from the chain would just reimplement waiting, badly.
     */
    public WarehouseRun runInline(Long id, String user, String year) {
        return runInline(id, user, year, java.util.Map.of());
    }

    public WarehouseRun runInline(Long id, String user, String year, java.util.Map<String, String> params) {
        WarehousePipeline p = tx.execute(s -> require(id));
        String y = year == null || year.isBlank() ? p.getFiscalYear() : year.trim();
        WarehouseRun saved = tx.execute(s -> {
            WarehouseRun run = new WarehouseRun();
            run.setPipelineId(p.getId());
            run.setStartedAt(OffsetDateTime.now());
            run.setTrigger("chain");
            run.setRunBy(user);
            run.setStatus("running");
            return runs.save(run);
        });
        work(saved.getId(), p.getId(), y, withDefaults(p.getParamsJson(), params));
        return tx.execute(s -> runs.findById(saved.getId()).orElse(saved));
    }

    /** Runs the load off-request and writes the outcome back onto the run row. */
    private void work(Long runId, Long pipelineId, String year, java.util.Map<String, String> params) {
        WarehousePipeline p = tx.execute(s -> repo.findById(pipelineId).orElse(null));
        if (p == null) return;
        // Start: a job cancelled while still queued is already finished — do not touch the database again.
        // A job still queued moves to "running" here, the only place that knows the worker picked it up.
        boolean proceed = Boolean.TRUE.equals(tx.execute(s -> {
            WarehouseRun r = runs.findById(runId).orElse(null);
            if (r == null || "cancelled".equals(r.getStatus())) return false;
            if ("queued".equals(r.getStatus())) {
                r.setStatus("running");
                runs.save(r);
                // Always set running without checking the old value — this job is the pipeline's latest activity
                // (two queued jobs of the same pipeline: the first already finished ok, the second was just picked;
                // requiring queued would refuse, and the screen would stop polling while the job runs).
                WarehousePipeline pp = repo.findById(pipelineId).orElse(null);
                if (pp != null) {
                    pp.setLastStatus("running");
                    repo.save(pp);
                }
            }
            return true;
        }));
        if (!proceed) { cancels.done(runId); return; }
        boolean yearDriven = p.getSourceSql() != null && YEAR_TOKEN.matcher(p.getSourceSql()).find();
        cancels.register(runId);
        LoadStats st = null;
        String err = null;
        // A pipeline with steps runs step by step; without steps it loads once as before (for pipelines
        // created before the migration ran — both paths give the same result for a one-step pipeline).
        java.util.List<io.reporthub.reportstudio.domain.WarehousePipelineStep> plan =
                tx.execute(sx -> steps.findByPipelineIdOrderByStepNoAsc(pipelineId));
        try {
            if (cancels.wasCancelled(runId)) {
                err = "Cancelled";
            } else {
                st = runStations(runId, p, plan == null ? java.util.List.of() : plan, year, params);
            }
        } catch (Exception e) {
            err = friendly(rootMessage(e));
        }
        final LoadStats fst = st;
        // Reconcile after a successful load — the data is fresh here, and a failing check must not turn
        // a successful load into an error (the reconcile result has its own error field).
        // Skipped if a cancel was requested — no point reconciling a load that did not finish.
        final Recon recon = (err == null && !cancels.wasCancelled(runId)
                && p.getControlColumn() != null && !p.getControlColumn().isBlank())
                ? reconcile(p, year, params) : null;
        // Read the flag after reconcile and unregister only AFTER writing the result — reconcile can take
        // up to 300s; unregistering earlier means a cancel in that window finds "no registered job",
        // closes the row itself, and then the worker overwrites it back to ok — a stopped job reverts to success.
        final boolean fcancelled = cancels.wasCancelled(runId);
        // ORA-01013 is what Statement.cancel looks like on Oracle — user-requested, not a failure.
        final String ferr = fcancelled ? "Cancelled by user while running" : err;
        tx.executeWithoutResult(s -> {
            WarehouseRun r = runs.findById(runId).orElse(null);
            WarehousePipeline pp = repo.findById(pipelineId).orElse(null);
            if (r == null || pp == null) return;
            r.setFinishedAt(OffsetDateTime.now());
            if (recon != null) {
                r.setSrcRows(recon.srcRows());
                r.setTgtRows(recon.tgtRows());
                r.setSrcSum(recon.srcSum());
                r.setTgtSum(recon.tgtSum());
                r.setReconStatus(recon.status());
                r.setReconMessage(recon.message());
            }
            if (ferr == null) {
                r.setStatus("ok");
                r.setRowsRead(fst.rowsRead());
                r.setRowsWritten(fst.rowsWritten());
                r.setMessage(summary(fst, yearDriven, year)
                        + (recon == null ? "" : " · " + recon.message()));
                pp.setLastStatus("ok");
                pp.setLastError(null);
                pp.setLastRowsRead(fst.rowsRead());
                pp.setLastRowsWritten(fst.rowsWritten());
            } else {
                r.setStatus(fcancelled ? "cancelled" : "error");
                r.setMessage(trunc(ferr));
                pp.setLastStatus(fcancelled ? "cancelled" : "error");
                pp.setLastError(fcancelled ? null : trunc(ferr));
            }
            runs.save(r);
            repo.save(pp);
        });
        cancels.done(runId);
    }

    /**
     * Run steps in order, writing each step's result row when the step starts, not when it ends.
     *
     * <p>The {@code running} row must exist from the start because a single step can take 6-27 minutes;
     * writing it at the end leaves the screen silent and nobody knows how far it got.
     *
     * @return totals for the whole chain — reads/writes summed over all steps, so the run row reads as before
     */
    private LoadStats runSteps(Long runId,
                               java.util.List<io.reporthub.reportstudio.domain.WarehousePipelineStep> plan,
                               String year, java.util.Map<String, String> params) throws Exception {
        var ctx = new io.reporthub.reportstudio.service.etl.StepContext(year, "pipeline");
        int read = 0, written = 0;
        boolean stopped = false;
        String firstFailure = null;
        for (var step : plan) {
            String label = step.getLabel() != null && !step.getLabel().isBlank()
                    ? step.getLabel()
                    : executors().containsKey(step.getKind()) ? executors().get(step.getKind()).label() : step.getKind();
            if (stopped || cancels.wasCancelled(runId)) {
                recordStep(runId, step, label, cancels.wasCancelled(runId) ? "cancelled" : "skipped",
                        null, null, cancels.wasCancelled(runId) ? "Not run — cancelled" : "Not run because a previous step failed");
                continue;
            }
            final var rec = new io.reporthub.reportstudio.domain.WarehouseRunStep();
            rec.setRunId(runId);
            rec.setStepNo(step.getStepNo());
            rec.setKind(step.getKind());
            rec.setLabel(label);
            rec.setStatus("running");
            tx.executeWithoutResult(sx -> runSteps.save(rec));
            try {
                var ex = executors().get(step.getKind());
                if (ex == null) throw new BadRequestException("Unknown step kind: " + step.getKind());
                @SuppressWarnings("unchecked")
                java.util.Map<String, Object> cfg = step.getConfig() == null || step.getConfig().isBlank()
                        ? java.util.Map.of() : json.readValue(step.getConfig(), java.util.Map.class);
                var res = ex.run(cfg, ctx);
                ctx.publish(step.getVarName() != null ? step.getVarName() : "step" + step.getStepNo(), res.output());
                rec.setStatus(res.ok() ? "success" : "failed");
                rec.setRowsRead(res.rowsRead());
                rec.setRowsWritten(res.affected());
                rec.setMessage(res.message());
                if (res.rowsRead() != null) read += res.rowsRead();
                if (res.affected() != null) written += res.affected();
                if (!res.ok()) {
                    if (firstFailure == null) firstFailure = "Step " + step.getStepNo() + " " + label + ": " + res.message();
                    stopped = "stop".equals(step.getOnFail());
                }
            } catch (Exception e) {
                rec.setStatus("failed");
                rec.setMessage(friendly(rootMessage(e)));
                if (firstFailure == null) firstFailure = "Step " + step.getStepNo() + " " + label + ": " + rec.getMessage();
                stopped = "stop".equals(step.getOnFail());
            }
            rec.setFinishedAt(OffsetDateTime.now());
            tx.executeWithoutResult(sx -> runSteps.save(rec));
        }
        // Any failed step = the whole run failed — a run reported as successful while a middle step broke is
        // the most dangerous kind of wrong answer (found only after the data is already in use).
        if (firstFailure != null) throw new BadRequestException(firstFailure);
        return new LoadStats(read, written, false);
    }

    /** Step numbers of the two stations every pipeline has, recorded around its own steps. */
    public static final int SOURCE_STEP_NO = 0;
    public static final int TARGET_STEP_NO = 9999;

    /**
     * Run a pipeline as a line of stations: Source (the pipeline's own SELECT, loaded into the target)
     * → each step in order (transforms / statements / asserts, which see the freshly loaded data)
     * → Target (final row count of schema.table). Every station writes its own run-step row when it
     * starts, so the screen can follow the run live.
     *
     * <p>A pipeline whose steps include a {@code load} step does its own loading — the pipeline-level
     * source/target is then not run (unchanged behaviour for those pipelines).
     */
    private LoadStats runStations(Long runId, WarehousePipeline p,
                                  java.util.List<io.reporthub.reportstudio.domain.WarehousePipelineStep> plan,
                                  String year, java.util.Map<String, String> params) throws Exception {
        boolean ownLoad = plan.stream().anyMatch(x -> "load".equals(x.getKind()));
        if (ownLoad) return runSteps(runId, plan, year, params);

        String target = (p.getTargetSchema() != null && !p.getTargetSchema().isBlank()
                ? p.getTargetSchema().trim() + "." : "") + p.getTargetTable();
        final var src = stationStart(runId, SOURCE_STEP_NO, "source", "Source");
        LoadStats st;
        try {
            st = load(p, year, params, runId);
        } catch (Exception e) {
            stationEnd(src, "failed", null, null, friendly(rootMessage(e)));
            for (var step : plan) {
                recordStep(runId, step, step.getLabel() != null && !step.getLabel().isBlank() ? step.getLabel() : step.getKind(),
                        cancels.wasCancelled(runId) ? "cancelled" : "skipped", null, null, "Not run because a previous step failed");
            }
            recordStation(runId, TARGET_STEP_NO, "target", "Target", "skipped", "Not run because a previous step failed");
            throw e;
        }
        stationEnd(src, "success", st.rowsRead(), st.rowsWritten(),
                String.format("%,d rows read · %,d written to %s", st.rowsRead(), st.rowsWritten(), target));
        if (!plan.isEmpty()) {
            try {
                runSteps(runId, plan, year, params);
            } catch (Exception e) {
                recordStation(runId, TARGET_STEP_NO, "target", "Target",
                        cancels.wasCancelled(runId) ? "cancelled" : "skipped", "Not run because a previous step failed");
                throw e;
            }
        }
        final var tgt = stationStart(runId, TARGET_STEP_NO, "target", "Target");
        TargetInfo ti = targetInfo(p.getId());
        Integer count = ti.rowCount() == null ? null : (int) Math.min(Integer.MAX_VALUE, ti.rowCount());
        stationEnd(tgt, ti.error() == null ? "success" : "failed", count, count,
                ti.error() != null ? ti.error()
                        : String.format("%s · %s · %s rows", target, p.getLoadMode(),
                        count == null ? "?" : String.format("%,d", count)));
        if (ti.error() != null) throw new BadRequestException("Target " + target + ": " + ti.error());
        return st;
    }

    private io.reporthub.reportstudio.domain.WarehouseRunStep stationStart(Long runId, int no, String kind, String label) {
        final var rec = new io.reporthub.reportstudio.domain.WarehouseRunStep();
        rec.setRunId(runId);
        rec.setStepNo(no);
        rec.setKind(kind);
        rec.setLabel(label);
        rec.setStatus("running");
        tx.executeWithoutResult(sx -> runSteps.save(rec));
        return rec;
    }

    private void stationEnd(io.reporthub.reportstudio.domain.WarehouseRunStep rec, String status,
                            Integer read, Integer written, String msg) {
        rec.setStatus(status);
        rec.setRowsRead(read);
        rec.setRowsWritten(written);
        rec.setMessage(msg);
        rec.setFinishedAt(OffsetDateTime.now());
        tx.executeWithoutResult(sx -> runSteps.save(rec));
    }

    private void recordStation(Long runId, int no, String kind, String label, String status, String msg) {
        stationEnd(stationStart(runId, no, kind, label), status, null, null, msg);
    }

    /** One run by id. */
    @Transactional(readOnly = true)
    public WarehouseRun run(Long runId) {
        return runs.findById(runId).orElseThrow(() -> new NotFoundException("Run not found: " + runId));
    }

    private void recordStep(Long runId, io.reporthub.reportstudio.domain.WarehousePipelineStep step,
                            String label, String status, Integer read, Integer written, String msg) {
        final var rec = new io.reporthub.reportstudio.domain.WarehouseRunStep();
        rec.setRunId(runId);
        rec.setStepNo(step.getStepNo());
        rec.setKind(step.getKind());
        rec.setLabel(label);
        rec.setStatus(status);
        rec.setRowsRead(read);
        rec.setRowsWritten(written);
        rec.setMessage(msg);
        rec.setFinishedAt(OffsetDateTime.now());
        tx.executeWithoutResult(sx -> runSteps.save(rec));
    }

    /**
     * Stop the job a chain is currently running — a chain runs step by step on the single worker, so at most
     * one run with trigger=chain is running. None = no-op (the active step may be a check/statement).
     */
    public void cancelActiveChainRun() {
        tx.execute(s -> runs.findFirstByTriggerAndStatusOrderByIdDesc("chain", "running"))
          .ifPresent(r -> cancels.cancel(r.getId()));
    }

    /**
     * Cancel one job — whether still queued (close the row now; the worker will skip it) or running
     * (set the flag + cancel the statement in the database; the worker then closes the row as cancelled).
     *
     * <p>Without this, a step stuck in free buffer waits could not be cancelled from the screen and needed
     * alter system kill session on Oracle directly, and jobs queued behind it could not be withdrawn.
     */
    @Transactional
    public WarehouseRun cancelRun(Long runId) {
        WarehouseRun r = runs.findById(runId)
                .orElseThrow(() -> new NotFoundException("Run not found: " + runId));
        if (!"queued".equals(r.getStatus()) && !"running".equals(r.getStatus())) {
            throw new BadRequestException("This job has already finished (" + r.getStatus() + ") — nothing to cancel");
        }
        boolean live = cancels.cancel(runId);   // always set the flag first, in case the worker is about to start
        if (!live) {
            // No registered job = still queued (or no longer on this instance) — close the row right here
            r.setStatus("cancelled");
            r.setMessage("Cancelled before it started");
            r.setFinishedAt(OffsetDateTime.now());
            runs.save(r);
            // Update the pipeline badge only when none of its other jobs are pending — removing a queued job
            // while the first job runs must not overwrite its running state (the screen would stop polling).
            boolean othersActive = runs
                    .findByPipelineIdOrderByStartedAtDesc(r.getPipelineId(),
                            org.springframework.data.domain.PageRequest.of(0, 20))
                    .stream()
                    .anyMatch(x -> !x.getId().equals(runId)
                            && ("running".equals(x.getStatus()) || "queued".equals(x.getStatus())));
            if (!othersActive) {
                repo.findById(r.getPipelineId()).ifPresent(p -> {
                    if ("queued".equals(p.getLastStatus()) || "running".equals(p.getLastStatus())) {
                        p.setLastStatus("cancelled");
                        p.setLastError(null);
                        repo.save(p);
                    }
                });
            }
            // Row closed — the worker skips this job at start; do not keep the flag or the registry leaks
            cancels.done(runId);
        }
        return runs.findById(runId).orElse(r);
    }

    private static String summary(LoadStats st, boolean yearDriven, String year) {
        // history has to say which year a run loaded, or two runs of one pipeline look identical
        return (yearDriven ? "year " + year + " · " : "")
                + (st.created() ? "created target · " : "")
                + (st.addedColumns().isEmpty() ? ""
                   : "added column(s) " + String.join(", ", st.addedColumns()) + " · ")
                + st.rowsRead() + " read · " + st.rowsWritten() + " written";
    }

    /**
     * Turns the driver's message into something the person looking at the screen can act on.
     * The raw text is kept after the hint — whoever debugs it next still needs the code.
     */
    public static String friendly(String raw) {
        if (raw == null) return null;
        String hint = null;
        if (raw.contains("ORA-01653") || raw.contains("ORA-01654") || raw.contains("ORA-01688")) {
            hint = "The target cannot extend — tablespace is full; ask a DBA to add space or move the table to another tablespace";
        } else if (raw.contains("ORA-00942")) {
            hint = "Table not found, or the connected user cannot see it — also check the schema name in the target table field";
        } else if (raw.contains("ORA-00911")) {
            hint = "The SQL contains stray characters, usually a NO-BREAK SPACE from copying via chat/Word — replace all spaces with plain spaces";
        } else if (raw.contains("ORA-01031") || raw.contains("ORA-01950")) {
            hint = "The connected user has no write permission on the target schema";
        } else if (raw.contains("ORA-00904")) {
            hint = "Invalid column name — a computed column needs an alias with AS";
        } else if (raw.contains("ORA-01722")) {
            hint = "Data type mismatch — the source sends text into a numeric column of the target";
        }
        return hint == null ? raw : hint + "  [" + raw.trim() + "]";
    }

    @Transactional
    public int runDue() {
        OffsetDateTime now = OffsetDateTime.now();
        List<WarehousePipeline> due = repo.findByEnabledTrueAndCronIsNotNullAndNextRunAtLessThanEqual(now);
        for (WarehousePipeline p : due) {
            p.setNextRunAt(nextFrom(p.getCron(), now));   // advance first so a slow run can't double-fire
            repo.save(p);
            // a timer has no portal to read the year from; run inside the pipeline's own tenant/project
            io.reporthub.reportstudio.tenancy.TenantContext.runAs(io.reporthub.reportstudio.tenancy.TenantContext.of(p.getTenantId(), p.getProjectId()),
                    () -> execute(p, "scheduled", "scheduler", p.getFiscalYear()));
        }
        return due.size();
    }

    /**
     * Fills the fiscal-year placeholders in a pipeline's source SQL.
     *
     * <p>{@code $YEAR4}/{@code $YEAR2} are the same tokens {@code repo_table.eq_filter} uses.
     *
     * <p>A data screen drops a year-bearing filter when the year is unknown, which is right for a
     * read. A pipeline must not: dropping the filter here would load <em>every</em> year into the
     * target table. A missing or malformed year is an error instead.
     */
    /**
     * Substitutes the run's parameter values into {@code $NAME} tokens.
     *
     * <p>Values are pasted as text, the same way {@code $YEAR4} is — a pipeline's SQL is written by
     * whoever configured it, not by the person clicking Run, so this is a fill-in-the-blank for an
     * author's own template rather than user input reaching SQL. The value is still refused if it
     * could end the statement, so a mistyped value cannot become a second statement.
     */
    /**
     * Declared parameter defaults ({@code params_json: [{"name","default"}]}) filled in for every
     * value the caller did not send, so scheduled and body-less runs resolve $NAME too.
     */
    /** Parameters of an unattended (scheduled) run: every declared default. */
    static java.util.Map<String, String> scheduledParams(WarehousePipeline p) {
        return withDefaults(p.getParamsJson(), java.util.Map.of());
    }

    static java.util.Map<String, String> withDefaults(String paramsJson, java.util.Map<String, String> given) {
        java.util.Map<String, String> out = new java.util.LinkedHashMap<>();
        if (paramsJson != null && !paramsJson.isBlank()) {
            try {
                for (com.fasterxml.jackson.databind.JsonNode n : new com.fasterxml.jackson.databind.ObjectMapper().readTree(paramsJson)) {
                    String name = n.path("name").asText("").trim();
                    com.fasterxml.jackson.databind.JsonNode d = n.has("default") ? n.get("default") : n.path("defaultValue");
                    if (!name.isEmpty() && d != null && !d.isNull() && !d.isMissingNode()) out.put(name, d.asText());
                }
            } catch (Exception ignored) {
                // unreadable declaration: no defaults
            }
        }
        if (given != null) {
            given.forEach((k, v) -> { if (v != null && !(v.isBlank() && out.containsKey(k))) out.put(k, v); });
        }
        return out;
    }

    public static String resolveParams(String sql, java.util.Map<String, String> params) {
        if (sql == null || params == null || params.isEmpty()) return sql;
        String out = sql;
        for (var e : params.entrySet()) {
            String name = e.getKey() == null ? "" : e.getKey().trim();
            if (!name.matches("[A-Za-z_][A-Za-z0-9_]*")) continue;
            if (name.equalsIgnoreCase("YEAR") || name.equalsIgnoreCase("YEAR4")
                    || name.equalsIgnoreCase("YEAR2")) continue;   // the year has its own resolver
            String v = e.getValue() == null ? "" : e.getValue();
            if (v.contains(";") || v.contains("--") || v.contains("/*")) {
                throw new BadRequestException("Parameter value " + name + " contains disallowed characters (; or comment)");
            }
            out = out.replace("$" + name, v);
        }
        return out;
    }

    public static String resolveYear(String sql, String year) {
        if (sql == null) return sql;
        Matcher m = YEAR_TOKEN.matcher(sql);
        if (!m.find()) return sql;
        String y = year == null ? "" : year.trim();
        if (!y.matches("\\d{4}")) {
            throw new BadRequestException("This SQL uses $YEAR4/$YEAR2 but did not receive a 4-digit fiscal year "
                    + "— set the year on the pipeline itself or pass one with the run"
                    + (y.isEmpty() ? "" : " (got '" + y + "')"));
        }
        StringBuilder out = new StringBuilder();
        m.reset();
        while (m.find()) {
            boolean shortForm = "2".equals(m.group(1));   // $YEAR:2 / $YEAR2
            m.appendReplacement(out, Matcher.quoteReplacement(shortForm ? y.substring(2) : y));
        }
        m.appendTail(out);
        return out.toString();
    }

    /**
     * First rows of what the source SQL actually returns, year already substituted — so an author
     * can look before writing anything into a target. Runs against the source connection only.
     */
    @Transactional(readOnly = true)
    public DatasetService.TableResult preview(String datasourceId, String sql, String year, int limit) {
        return datasets.preview(datasourceId, resolveYear(sql, year), Math.min(Math.max(limit, 1), 500));
    }

    /** What is actually sitting in the target right now — the run log alone can be stale. */
    public record TargetInfo(String schema, String table, boolean exists, Long rowCount, String error) {}

    @Transactional(readOnly = true)
    public TargetInfo targetInfo(Long id) {
        WarehousePipeline p = require(id);
        try (Connection tgt = db.open(p.getTargetDatasourceId(), true)) {
            String schema = p.getTargetSchema() != null && !p.getTargetSchema().isBlank()
                    ? p.getTargetSchema().trim()
                    : targetSchema(tgt, p.getTargetDatasourceId());
            if (!tableExists(tgt, schema, p.getTargetTable())) {
                return new TargetInfo(schema, p.getTargetTable(), false, null, null);
            }
            try (java.sql.Statement st = tgt.createStatement();
                 ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + qualify(schema, p.getTargetTable()))) {
                rs.next();
                return new TargetInfo(schema, p.getTargetTable(), true, rs.getLong(1), null);
            }
        } catch (Exception e) {
            return new TargetInfo(p.getTargetSchema(), p.getTargetTable(), false, null, friendly(rootMessage(e)));
        }
    }

    // ---- the load ----------------------------------------------------------

    private WarehouseRun execute(WarehousePipeline p, String trigger, String user, String year) {
        WarehouseRun run = new WarehouseRun();
        run.setPipelineId(p.getId());
        run.setStartedAt(OffsetDateTime.now());
        run.setTrigger(trigger);
        run.setRunBy(user);
        boolean yearDriven = p.getSourceSql() != null && YEAR_TOKEN.matcher(p.getSourceSql()).find();
        try {
            // Scheduled runs use the pipeline's parameter defaults, exactly like a manual run with no input.
            java.util.Map<String, String> params = scheduledParams(p);
            LoadStats st = load(p, year, params, null);
            // Scheduled runs must be reconciled too — unattended runs need a check even more
            Recon recon = p.getControlColumn() != null && !p.getControlColumn().isBlank()
                    ? reconcile(p, year, params) : null;
            if (recon != null) {
                run.setSrcRows(recon.srcRows());
                run.setTgtRows(recon.tgtRows());
                run.setSrcSum(recon.srcSum());
                run.setTgtSum(recon.tgtSum());
                run.setReconStatus(recon.status());
                run.setReconMessage(recon.message());
            }
            run.setStatus("ok");
            run.setRowsRead(st.rowsRead());
            run.setRowsWritten(st.rowsWritten());
            run.setMessage(summary(st, yearDriven, year) + (recon == null ? "" : " · " + recon.message()));
            p.setLastStatus("ok");
            p.setLastError(null);
            p.setLastRowsRead(st.rowsRead());
            p.setLastRowsWritten(st.rowsWritten());
        } catch (Exception e) {
            String msg = trunc(friendly(rootMessage(e)));
            run.setStatus("error");
            run.setMessage(msg);
            p.setLastStatus("error");
            p.setLastError(msg);
        }
        run.setFinishedAt(OffsetDateTime.now());
        // Never repo.save(p) — p was read before a pipeline that takes minutes;
        //    if someone edits this pipeline meanwhile, the new SQL/name/target would be silently overwritten
        //    with old values. So only the run-result fields are stamped.
        p.setLastRunAt(run.getStartedAt());
        repo.touchLastRun(p.getId(), run.getStartedAt(), p.getLastStatus(), p.getLastError(),
                          p.getLastRowsRead(), p.getLastRowsWritten());
        return runs.save(run);
    }

    /**
     * Package-visible so an inline chain step can perform the same load from a config it holds
     * itself, without a saved pipeline row standing in for it. The pipeline object is just the
     * parameter carrier here — nothing is read back from the database.
     */
    /** Reconcile result of one run — status: match | mismatch | error */
    public record Recon(Long srcRows, java.math.BigDecimal srcSum,
                        Long tgtRows, java.math.BigDecimal tgtSum,
                        String status, String message) {}

    /**
     * Compare "row count + control-column sum" between the target and the source query — both sides are
     * aggregates in the database; no rows travel back.
     *
     * <p>The target side counts only the scope this pipeline owns, not the whole table: partition mode
     * reads a single {@code PARTITION FOR (key)}; delete mode uses the same clearWhere predicate
     * (counting a whole multi-GB table while users have screens open can saturate the database).
     *
     * <p>A failed check returns status error instead of throwing — successfully loaded data must not
     * look broken because of the checker itself, e.g. a control column containing text TO_NUMBER cannot parse.
     */
    private Recon reconcile(WarehousePipeline p, String year, java.util.Map<String, String> params) {
        try {
            String col = p.getControlColumn().trim();
            checkIdent(col);
            String sourceSql = resolveParams(resolveYear(p.getSourceSql(), year), params);
            String scope = resolveParams(resolveYear(p.getClearWhere(), year), params);
            boolean tgtOracle = db.isOracle(p.getTargetDatasourceId());
            boolean srcOracle = db.isOracle(p.getSourceDatasourceId());
            long srcRows; java.math.BigDecimal srcSum;
            long tgtRows; java.math.BigDecimal tgtSum;
            try (Connection src = db.open(p.getSourceDatasourceId(), true)) {
                String num = srcOracle ? "TO_NUMBER(" + quote(col) + ")" : "CAST(" + quote(col) + " AS NUMERIC)";
                try (java.sql.Statement stq = src.createStatement()) {
                    stq.setQueryTimeout(RECON_TIMEOUT_SECONDS);
                    try (ResultSet rs = stq.executeQuery(
                            "SELECT COUNT(*), SUM(" + num + ") FROM (" + sourceSql + ") recon_src")) {
                        rs.next();
                        srcRows = rs.getLong(1);
                        srcSum = rs.getBigDecimal(2);
                    }
                }
            }
            try (Connection tgt = db.open(p.getTargetDatasourceId(), true)) {
                String schema = p.getTargetSchema() != null && !p.getTargetSchema().isBlank()
                        ? p.getTargetSchema().trim()
                        : targetSchema(tgt, p.getTargetDatasourceId());
                String from = qualify(schema, p.getTargetTable());
                String where = "";
                // clearWhere is "the scope this pipeline owns" only in replace mode;
                // append/upsert clear nothing, so the table still holds earlier runs — cannot be compared
                if (!"replace".equals(p.getLoadMode())) {
                    return new Recon(srcRows, srcSum == null ? java.math.BigDecimal.ZERO : srcSum,
                            null, null, "error",
                            "Reconcile works only in replace mode — in " + p.getLoadMode()
                            + " mode the target table still contains earlier runs, so this run's scope cannot be isolated");
                }
                if (scope != null && !scope.isBlank()) {
                    if ("partition".equalsIgnoreCase(p.getClearMode())) {
                        String k = scope.trim();
                        if (k.contains("'") || k.contains(";") || k.contains("--")) {
                            throw new BadRequestException("Invalid partition key value: " + scope);
                        }
                        from += " PARTITION FOR ('" + k + "')";
                    } else {
                        assertScopePredicate(scope);
                        where = " WHERE " + scope;
                    }
                }
                String num = tgtOracle ? "TO_NUMBER(" + quote(col) + ")" : "CAST(" + quote(col) + " AS NUMERIC)";
                try (java.sql.Statement stq = tgt.createStatement()) {
                    stq.setQueryTimeout(RECON_TIMEOUT_SECONDS);
                    try (ResultSet rs = stq.executeQuery(
                            "SELECT COUNT(*), SUM(" + num + ") FROM " + from + where)) {
                        rs.next();
                        tgtRows = rs.getLong(1);
                        tgtSum = rs.getBigDecimal(2);
                    }
                }
            }
            java.math.BigDecimal ss = srcSum == null ? java.math.BigDecimal.ZERO : srcSum;
            java.math.BigDecimal ts = tgtSum == null ? java.math.BigDecimal.ZERO : tgtSum;
            java.math.BigDecimal diff = ts.subtract(ss);
            java.math.BigDecimal tol = p.getControlTolerance() == null
                    ? java.math.BigDecimal.ZERO : p.getControlTolerance();
            boolean match = tgtRows == srcRows && diff.abs().compareTo(tol) <= 0;
            String msg = match
                    ? "Matches source — " + String.format("%,d", tgtRows) + " rows, total " + money(ts)
                    : "Does not match source — rows " + String.format("%,d", tgtRows) + "/"
                      + String.format("%,d", srcRows) + " (" + String.format("%+,d", tgtRows - srcRows)
                      + "), sum difference " + money(diff);
            return new Recon(srcRows, ss, tgtRows, ts, match ? "match" : "mismatch", msg);
        } catch (Exception e) {
            return new Recon(null, null, null, null, "error",
                    "Reconcile failed: " + trunc(friendly(rootMessage(e))));
        }
    }

    private static String money(java.math.BigDecimal v) {
        return String.format("%,.2f", v);
    }

    /** Reconcile is two aggregate queries — over a minute means the scope is wrong or the DB is in trouble; do not hang. */
    private static final int RECON_TIMEOUT_SECONDS = 300;

    public LoadStats loadWith(WarehousePipeline p, String year) throws Exception {
        return load(p, year, java.util.Map.of(), null);
    }

    /** Result of one load step: load counts + reconcile result (null = this step has no control column). */
    public record Loaded(LoadStats stats, Recon recon) {}

    /**
     * Load then reconcile in one place — for chain steps, which need both before deciding
     * whether to continue to the next step.
     */
    public Loaded loadAndReconcile(WarehousePipeline p, String year) throws Exception {
        LoadStats st = load(p, year, java.util.Map.of(), null);
        Recon rc = p.getControlColumn() != null && !p.getControlColumn().isBlank()
                ? reconcile(p, year, java.util.Map.of()) : null;
        return new Loaded(st, rc);
    }

    /** @param runId when not null, every statement of this job is registered so it can be cancelled mid-run */
    private LoadStats load(WarehousePipeline p, String year, java.util.Map<String, String> params,
                           Long runId) throws Exception {
        String sourceSql = resolveParams(resolveYear(p.getSourceSql(), year), params);
        DatasetService.validateSql(sourceSql);            // SELECT-only guard, on what actually runs
        String mode = p.getLoadMode();
        List<String> keyCols = "upsert".equals(mode) ? csv(p.getKeyColumns()) : List.of();
        if ("upsert".equals(mode) && keyCols.isEmpty()) {
            throw new BadRequestException("Upsert needs at least one key column");
        }
        boolean targetOracle = db.isOracle(p.getTargetDatasourceId());

        try (Connection src = cancels.track(runId, db.open(p.getSourceDatasourceId(), true));
             Connection tgt = cancels.track(runId, db.open(p.getTargetDatasourceId(), false))) {
            src.setAutoCommit(false);                       // lets Postgres stream instead of buffering
            try (PreparedStatement sps = src.prepareStatement(sourceSql)) {
                sps.setFetchSize(BATCH);
                // Same database on both sides? Then the rows never need to travel through here.
                // Streaming many wide rows out and batching them back in is all round-trip and
                // buffer-cache churn; the server can do the whole move in one statement.
                // Upsert still needs the row-by-row path — it deletes per key as it goes.
                boolean sameDb = p.getSourceDatasourceId() != null
                        && p.getSourceDatasourceId().equals(p.getTargetDatasourceId())
                        && !"upsert".equals(mode);
                ResultSet rs = null;
                try {
                    ResultSetMetaData md = sameDb ? sps.getMetaData() : null;
                    if (md == null) {                       // driver would not describe it — fall back
                        sameDb = false;
                        rs = sps.executeQuery();
                        md = rs.getMetaData();
                    }
                    List<String> cols = new ArrayList<>();
                    for (int i = 1; i <= md.getColumnCount(); i++) cols.add(md.getColumnLabel(i));
                    cols.forEach(WarehouseService::checkIdent);
                    keyCols.forEach(k -> {
                        if (cols.stream().noneMatch(c -> c.equalsIgnoreCase(k)))
                            throw new BadRequestException("Key column not in the source result: " + k);
                    });

                    String schema = p.getTargetSchema() != null && !p.getTargetSchema().isBlank()
                            ? p.getTargetSchema().trim()
                            : targetSchema(tgt, p.getTargetDatasourceId());
                    boolean exists = tableExists(tgt, schema, p.getTargetTable());
                    boolean created = false;
                    List<String> addedCols = List.of();
                    if (!exists) {
                        if (!p.isAutoCreate()) {
                            throw new BadRequestException("Target table '" + p.getTargetTable()
                                    + "' does not exist (enable Auto-create to build it from the query result)");
                        }
                        createTable(tgt, schema, p.getTargetTable(), cols, md, targetOracle);
                        created = true;
                    } else {
                        addedCols = addMissingColumns(tgt, schema, p.getTargetTable(), cols, md,
                                                      targetOracle, p.isAddColumns());
                    }

                    tgt.setAutoCommit(false);
                    try {
                        if ("replace".equals(mode) && !created) {
                            clearTable(tgt, schema, p.getTargetTable(), p.getClearMode(),
                                       resolveParams(resolveYear(p.getClearWhere(), year), params));
                        }
                        LoadStats s = sameDb
                                ? insertSelect(tgt, schema, p.getTargetTable(), cols, sourceSql)
                                : stream(rs, tgt, schema, p.getTargetTable(), cols, keyCols, mode);
                        tgt.commit();
                        return new LoadStats(s.rowsRead(), s.rowsWritten(), created, addedCols);
                    } catch (Exception e) {
                        try { tgt.rollback(); } catch (Exception ignored) { /* best effort */ }
                        throw e;
                    }
                } finally {
                    if (rs != null) try { rs.close(); } catch (Exception ignored) { /* best effort */ }
                }
            }
        }
    }

    /**
     * Server-side move for the same-database case: {@code INSERT INTO target (cols) SELECT * FROM (source)}.
     *
     * <p>The column list comes from the source's own result metadata and the SELECT keeps its original
     * order, so the two line up positionally without naming anything twice. Nothing is fetched into
     * this process, which is the whole point — a large slice stops being hundreds of round trips of wide
     * rows and becomes one statement the database plans and executes on its own.
     */
    private LoadStats insertSelect(Connection tgt, String schema, String table,
                                   List<String> cols, String sourceSql) throws Exception {
        String colList = String.join(", ", cols.stream().map(WarehouseService::quote).toList());
        String sql = "INSERT INTO " + qualify(schema, table) + " (" + colList + ")\n"
                   + "SELECT * FROM (" + sourceSql + ")";
        try (java.sql.Statement st = tgt.createStatement()) {
            int n = st.executeUpdate(sql);
            return new LoadStats(n, n, false);
        }
    }

    private LoadStats stream(ResultSet rs, Connection tgt, String schema, String table,
                             List<String> cols, List<String> keyCols, String mode) throws Exception {
        String fq = qualify(schema, table);
        String colList = String.join(", ", cols.stream().map(WarehouseService::quote).toList());
        String binds = String.join(", ", cols.stream().map(c -> "?").toList());
        String insertSql = "INSERT INTO " + fq + " (" + colList + ") VALUES (" + binds + ")";
        String deleteSql = keyCols.isEmpty() ? null : "DELETE FROM " + fq + " WHERE "
                + String.join(" AND ", keyCols.stream().map(c -> quote(realCol(cols, c)) + " = ?").toList());

        int read = 0, written = 0, batch = 0;
        try (PreparedStatement ins = tgt.prepareStatement(insertSql);
             PreparedStatement del = deleteSql == null ? null : tgt.prepareStatement(deleteSql)) {
            while (rs.next()) {
                read++;
                if (del != null) {                          // upsert: clear the existing keyed row first
                    int k = 1;
                    for (String key : keyCols) del.setObject(k++, rs.getObject(realCol(cols, key)));
                    del.executeUpdate();
                }
                for (int i = 1; i <= cols.size(); i++) ins.setObject(i, rs.getObject(i));
                ins.addBatch();
                written++;
                if (++batch >= BATCH) { ins.executeBatch(); batch = 0; }
            }
            if (batch > 0) ins.executeBatch();
        }
        return new LoadStats(read, written, false);
    }

    // ---- DDL / metadata ----------------------------------------------------

    private boolean tableExists(Connection con, String schema, String table) throws Exception {
        try (ResultSet rs = con.getMetaData().getTables(con.getCatalog(), schema, table,
                new String[]{"TABLE"})) {
            while (rs.next()) {
                if (table.equalsIgnoreCase(rs.getString("TABLE_NAME"))) return true;
            }
        }
        return false;
    }

    private void createTable(Connection con, String schema, String table, List<String> cols,
                             ResultSetMetaData md, boolean oracle) throws Exception {
        StringBuilder ddl = new StringBuilder("CREATE TABLE ").append(qualify(schema, table)).append(" (");
        for (int i = 1; i <= cols.size(); i++) {
            if (i > 1) ddl.append(", ");
            ddl.append(quote(cols.get(i - 1))).append(' ')
               .append(ddlType(md.getColumnType(i), md.getPrecision(i), md.getScale(i), oracle));
        }
        ddl.append(')');
        try (java.sql.Statement st = con.createStatement()) { st.execute(ddl.toString()); }
    }

    /**
     * Widen an existing target so a query that grew can still land in it.
     *
     * <p>Reusing a table and adding a field to it is a normal way to work here — a generated table
     * gains a column when the report it feeds gains one. Without this the load fails on the INSERT
     * with nothing but "invalid identifier", and the only way forward is to drop the table and lose
     * its data.
     *
     * <p>Off unless the pipeline asks for it. Altering a table someone else may depend on is not
     * something to do because a SELECT happened to mention a new name — a typo in the query would
     * otherwise leave a permanent stray column behind. When it is off and columns are missing, the
     * error says which ones and what to switch on, instead of letting the driver complain.
     *
     * <p>Only ever adds. Columns the target has and the query does not are left alone: the query is
     * one of possibly several writers, and its silence about a column is not a request to drop it.
     *
     * @return the columns actually added, for the run history
     */
    private List<String> addMissingColumns(Connection con, String schema, String table,
                                           List<String> cols, ResultSetMetaData md,
                                           boolean oracle, boolean allowed) throws Exception {
        Set<String> have = new LinkedHashSet<>();
        DatabaseMetaData dbmd = con.getMetaData();
        try (ResultSet rs = dbmd.getColumns(con.getCatalog(), schema, table, "%")) {
            while (rs.next()) have.add(rs.getString("COLUMN_NAME").toUpperCase(Locale.ROOT));
        }
        List<Integer> missingIdx = new ArrayList<>();
        for (int i = 1; i <= cols.size(); i++) {
            if (!have.contains(cols.get(i - 1).toUpperCase(Locale.ROOT))) missingIdx.add(i);
        }
        if (missingIdx.isEmpty()) return List.of();

        List<String> names = missingIdx.stream().map(i -> cols.get(i - 1)).toList();
        if (!allowed) {
            throw new BadRequestException("Target table is missing columns: " + String.join(", ", names)
                    + " — enable \"Add missing columns automatically\" to let the system add them"
                    + " or change the SELECT to match the existing table");
        }
        StringBuilder ddl = new StringBuilder("ALTER TABLE ").append(qualify(schema, table))
                .append(oracle ? " ADD (" : " ADD COLUMN ");
        for (int n = 0; n < missingIdx.size(); n++) {
            int i = missingIdx.get(n);
            if (n > 0) ddl.append(oracle ? ", " : ", ADD COLUMN ");
            ddl.append(quote(cols.get(i - 1))).append(' ')
               .append(ddlType(md.getColumnType(i), md.getPrecision(i), md.getScale(i), oracle));
        }
        if (oracle) ddl.append(')');
        // Oracle commits DDL implicitly, so this lands before the load transaction opens — which is
        // why it happens here rather than inside it.
        try (java.sql.Statement st = con.createStatement()) { st.execute(ddl.toString()); }
        return names;
    }

    /**
     * Empties the target before a Replace load.
     *
     * <p>DELETE is the default because it participates in the surrounding transaction: a load that
     * fails half-way leaves the old rows intact. TRUNCATE is opt-in per pipeline for extracts big
     * enough that per-row undo and archive log dominate the run (large extracts that are fully reloaded
     * every time) — it commits implicitly on Oracle, so a later failure leaves the target empty.
     */
    private void clearTable(Connection con, String schema, String table, String clearMode,
                            String scope) throws Exception {
        if (scope != null && !scope.isBlank()) {
            // Scoped Replace: this pipeline owns one slice of the target, so only that slice goes.
            //
            // "partition" means the target is list-partitioned on exactly this slice, and the scope
            // holds the partition key rather than a predicate. Dropping a partition is a data
            // dictionary change — no undo, no redo, no buffer churn — where the equivalent DELETE of
            // many wide rows is typically the slowest step of a load. The price is that this cannot be rolled back with the insert,
            // so a failure mid-load leaves that one slice empty; a re-run fills it again.
            if ("partition".equalsIgnoreCase(clearMode)) {
                truncatePartition(con, schema, table, scope);
                return;
            }
            // Otherwise the scope is a predicate: DELETE, which also keeps it inside the transaction.
            assertScopePredicate(scope);
            try (java.sql.Statement st = con.createStatement()) {
                st.executeUpdate("DELETE FROM " + qualify(schema, table) + " WHERE " + scope);
            }
            return;
        }
        boolean truncate = "truncate".equalsIgnoreCase(clearMode);
        try (java.sql.Statement st = con.createStatement()) {
            st.executeUpdate((truncate ? "TRUNCATE TABLE " : "DELETE FROM ") + qualify(schema, table));
        }
    }

    /**
     * Empties the one list partition whose key is {@code key} — the fast path behind clear mode
     * "partition".
     *
     * <p>{@code TRUNCATE PARTITION FOR (key)} names the partition by a value inside it, so nothing
     * has to know the generated partition name. A stage that has never been loaded has no partition
     * yet; Oracle says so with ORA-02149 and that is simply nothing to clear, not a failure.
     */
    private void truncatePartition(Connection con, String schema, String table, String key)
            throws Exception {
        String k = key.trim();
        if (k.contains("'") || k.contains(";") || k.contains("--")) {
            throw new BadRequestException("Invalid partition key value: " + key);
        }
        try (java.sql.Statement st = con.createStatement()) {
            st.executeUpdate("ALTER TABLE " + qualify(schema, table)
                    + " TRUNCATE PARTITION FOR ('" + k + "')");
        } catch (java.sql.SQLException e) {
            // This stage has never been loaded, so there is no partition to clear — not an error.
            // 19c can answer either ORA-02149 (specified partition does not exist) or
            // ORA-14702 (partition number out of range) depending on how it is referenced
            int code = e.getErrorCode();
            if (code == 2149 || code == 14702 || code == 14501) return;
            throw e;
        }
    }

    /**
     * The scope predicate is pasted into a DELETE, so it is checked the way the SQL editor checks
     * what it runs: judged on the statement with comments and string literals blanked out, since a
     * word inside a literal is not a keyword and a comment cannot end a statement.
     *
     * <p>Refused: anything that could close the DELETE and start a second statement, or that turns
     * the delete into something wider than a filter. A predicate that is merely wrong deletes the
     * wrong rows — that is the author's problem — but it can never run a second statement.
     */
    static void assertScopePredicate(String scope) {
        String code = DatasetService.codeOnly(scope).toLowerCase(java.util.Locale.ROOT);
        if (code.isBlank()) {
            throw new BadRequestException("Delete condition is empty — to clear the whole table, leave this field blank");
        }
        if (code.contains(";")) {
            throw new BadRequestException("Delete condition must be a single condition, no ';'");
        }
        for (String banned : new String[]{"insert ", "update ", "delete ", "merge ", "drop ", "alter ",
                                          "truncate ", "grant ", "revoke ", "create ", "commit", "rollback"}) {
            if (code.contains(banned)) {
                throw new BadRequestException("Delete condition contains a disallowed statement: " + banned.trim());
            }
        }
    }

    private static String ddlType(int sqlType, int precision, int scale, boolean oracle) {
        return switch (sqlType) {
            case Types.TINYINT, Types.SMALLINT, Types.INTEGER -> oracle ? "NUMBER(10)" : "INTEGER";
            case Types.BIGINT -> oracle ? "NUMBER(19)" : "BIGINT";
            case Types.DECIMAL, Types.NUMERIC -> oracle ? "NUMBER"
                    : (precision > 0 && precision <= 1000
                        ? "NUMERIC(" + precision + "," + Math.max(scale, 0) + ")" : "NUMERIC");
            case Types.REAL, Types.FLOAT, Types.DOUBLE -> oracle ? "BINARY_DOUBLE" : "DOUBLE PRECISION";
            case Types.BIT, Types.BOOLEAN -> oracle ? "NUMBER(1)" : "BOOLEAN";
            case Types.DATE -> oracle ? "DATE" : "DATE";
            case Types.TIME -> oracle ? "DATE" : "TIME";
            case Types.TIMESTAMP, Types.TIMESTAMP_WITH_TIMEZONE -> "TIMESTAMP";
            default -> oracle ? "VARCHAR2(4000)" : "TEXT";
        };
    }

    private static String targetSchema(Connection con, String datasourceId) throws Exception {
        if (datasourceId == null || datasourceId.isBlank()) return null;        // internal Postgres → public
        if (!con.getMetaData().getURL().startsWith("jdbc:oracle")) return null;
        String s = con.getSchema();
        return (s == null || s.isBlank()) ? con.getMetaData().getUserName() : s;
    }

    // ---- validation / helpers ----------------------------------------------

    private static void validate(WarehousePipeline f) {
        if (f.getName() == null || f.getName().isBlank()) throw new BadRequestException("Name is required");
        if (f.getSourceSql() == null || f.getSourceSql().isBlank()) throw new BadRequestException("Source SQL is required");
        DatasetService.validateSql(f.getSourceSql());
        if (f.getTargetTable() == null || !IDENT.matcher(f.getTargetTable().trim()).matches()) {
            throw new BadRequestException("Target table must be a simple identifier (letters, digits, underscore)");
        }
        String mode = f.getLoadMode();
        if (!List.of("replace", "append", "upsert").contains(mode)) {
            throw new BadRequestException("Load mode must be replace, append or upsert");
        }
        if ("upsert".equals(mode) && csv(f.getKeyColumns()).isEmpty()) {
            throw new BadRequestException("Upsert needs at least one key column");
        }
        if (f.getCron() != null && !f.getCron().isBlank()) {
            try { io.reporthub.reportstudio.util.Cron.parse(f.getCron()); }
            catch (IllegalArgumentException e) { throw new BadRequestException("Invalid cron: " + e.getMessage()); }
        }
        String fy = f.getFiscalYear() == null ? "" : f.getFiscalYear().trim();
        if (!fy.isEmpty() && !fy.matches("\\d{4}")) {
            throw new BadRequestException("Fiscal year must be 4 digits (e.g. 2026)");
        }
        // A timer cannot ask the portal what year it is, so a scheduled year-driven pipeline that
        // has no year of its own would fail on every fire. Refuse it at save time instead.
        if (fy.isEmpty() && f.getCron() != null && !f.getCron().isBlank()
                && YEAR_TOKEN.matcher(f.getSourceSql()).find()) {
            throw new BadRequestException("This SQL uses $YEAR4/$YEAR2 — a scheduled pipeline must specify a fiscal year");
        }
    }

    private static List<String> csv(String s) {
        if (s == null || s.isBlank()) return List.of();
        Set<String> out = new LinkedHashSet<>();
        for (String part : s.split(",")) { String t = part.trim(); if (!t.isEmpty()) out.add(t); }
        return new ArrayList<>(out);
    }

    /** Resolve a key name to the source column's actual label (case-insensitive). */
    private static String realCol(List<String> cols, String want) {
        return cols.stream().filter(c -> c.equalsIgnoreCase(want)).findFirst().orElse(want);
    }

    private static void checkIdent(String ident) {
        if (ident == null || !IDENT.matcher(ident).matches()) {
            throw new BadRequestException("Result column name is not a valid identifier: '" + ident
                    + "' — alias it in the SELECT (e.g. AS my_col)");
        }
    }

    private static String qualify(String schema, String table) {
        return (schema == null || schema.isBlank() ? "" : quote(schema) + ".") + quote(table);
    }

    private static String quote(String ident) {
        if (ident == null || ident.contains("\"")) throw new BadRequestException("Invalid identifier: " + ident);
        return "\"" + ident + "\"";
    }

    private static OffsetDateTime nextFrom(String cron, OffsetDateTime from) {
        ZonedDateTime next = io.reporthub.reportstudio.util.Cron.parse(cron).next(from.toZonedDateTime());
        return next == null ? null : next.toOffsetDateTime();
    }

    private static String rootMessage(Throwable e) {
        Throwable c = e;
        while (c.getCause() != null && c.getCause() != c) c = c.getCause();
        return c.getMessage() == null ? e.toString() : c.getMessage();
    }

    private static String blank(String s) { return (s == null || s.isBlank()) ? null : s.trim(); }

    private static String trunc(String s) {
        if (s == null) return null;
        return s.length() > 4000 ? s.substring(0, 4000) : s;
    }
}
