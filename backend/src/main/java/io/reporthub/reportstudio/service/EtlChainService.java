package io.reporthub.reportstudio.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import io.reporthub.reportstudio.domain.DataCheck;
import io.reporthub.reportstudio.domain.DataCheckRun;
import io.reporthub.reportstudio.domain.EtlChain;
import io.reporthub.reportstudio.domain.EtlChainRun;
import io.reporthub.reportstudio.domain.EtlChainRunStep;
import io.reporthub.reportstudio.domain.EtlChainStep;
import io.reporthub.reportstudio.domain.Scheduler;
import io.reporthub.reportstudio.domain.SchedulerRun;
import io.reporthub.reportstudio.domain.WarehousePipeline;
import io.reporthub.reportstudio.domain.WarehouseRun;
import io.reporthub.reportstudio.repo.DataCheckRepository;
import io.reporthub.reportstudio.repo.EtlChainRepository;
import io.reporthub.reportstudio.repo.EtlChainRunRepository;
import io.reporthub.reportstudio.repo.EtlChainRunStepRepository;
import io.reporthub.reportstudio.repo.EtlChainStepRepository;
import io.reporthub.reportstudio.repo.SchedulerRepository;
import io.reporthub.reportstudio.repo.WarehousePipelineRepository;
import io.reporthub.reportstudio.service.etl.ChainStepExecutor;
import io.reporthub.reportstudio.service.etl.StepContext;
import io.reporthub.reportstudio.service.etl.StepResult;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Runs a {@link EtlChain} — an ordered list of pipelines and checks the user assembled — as one
 * round, and records what each step did.
 *
 * <p>The service knows nothing about any particular subject area. A chain that happens to build
 * one staging table and then derive several tables from it is exactly as much "a chain" as any other:
 * the ordering, the year and the pass/fail policy are all data.
 */
@Service
public class EtlChainService {

    private final EtlChainRepository chains;
    private final EtlChainStepRepository steps;
    private final EtlChainRunRepository runs;
    private final EtlChainRunStepRepository runSteps;
    private final WarehousePipelineRepository pipelines;
    private final DataCheckRepository checks;
    private final SchedulerRepository schedulers;
    private final WarehouseService warehouse;
    private final DataCheckService checkService;
    private final SchedulerService schedulerService;
    private final TransactionTemplate tx;

    /**
     * The step-type registry. Spring hands over every {@link ChainStepExecutor} bean, so a new step
     * type is a new class and nothing here changes. The three referential kinds
     * (pipeline/check/statement) are not executors — they run a saved object rather than a program
     * of their own — and stay handled directly in {@link #work}.
     */
    private final Map<String, ChainStepExecutor> executors = new LinkedHashMap<>();
    private final com.fasterxml.jackson.databind.ObjectMapper json =
            new com.fasterxml.jackson.databind.ObjectMapper();

    /**
     * One worker, like the warehouse runner: chains write to target tables, and two rounds of the
     * same chain running at once would interleave loads into the same tables.
     */
    private final ExecutorService pool =
            Executors.newSingleThreadExecutor(r -> new Thread(r, "etl-chain-run"));

    /**
     * Per-run cancel flags keyed by run id. Set by {@link #cancel}; the loop in {@link #work}
     * checks before every next step (single replica, so an in-process registry suffices — same as
     * WarehouseCancelRegistry)
     */
    private final Map<Long, java.util.concurrent.atomic.AtomicBoolean> cancelFlags =
            new java.util.concurrent.ConcurrentHashMap<>();

    public EtlChainService(EtlChainRepository chains, EtlChainStepRepository steps,
                           EtlChainRunRepository runs, EtlChainRunStepRepository runSteps,
                           WarehousePipelineRepository pipelines, DataCheckRepository checks,
                           SchedulerRepository schedulers, WarehouseService warehouse,
                           DataCheckService checkService, SchedulerService schedulerService,
                           TransactionTemplate tx, List<ChainStepExecutor> stepExecutors) {
        this.chains = chains;
        this.steps = steps;
        this.runs = runs;
        this.runSteps = runSteps;
        this.pipelines = pipelines;
        this.checks = checks;
        this.schedulers = schedulers;
        this.warehouse = warehouse;
        this.checkService = checkService;
        this.schedulerService = schedulerService;
        this.tx = tx;
        for (ChainStepExecutor e : stepExecutors) executors.put(e.type(), e);
    }

    /** Step types offered by the editor: the referential three plus every registered executor. */
    @Transactional(readOnly = true)
    public List<Map<String, String>> stepTypes() {
        List<Map<String, String>> out = new ArrayList<>(List.of(
                Map.of("type", "pipeline", "label", "Saved data pipeline", "mode", "ref"),
                Map.of("type", "check", "label", "Saved check set", "mode", "ref"),
                Map.of("type", "statement", "label", "Saved SQL statement", "mode", "ref")));
        executors.forEach((t, e) -> out.add(Map.of("type", t, "label", e.label(), "mode", "inline")));
        return out;
    }

    // ---- chains ------------------------------------------------------------

    @Transactional(readOnly = true)
    public List<EtlChain> list() {
        return chains.findAllByOrderByFolderAscNameAsc();
    }

    @Transactional(readOnly = true)
    public EtlChain require(Long id) {
        return chains.findById(id).orElseThrow(() -> new NotFoundException("Chain not found: " + id));
    }

    @Transactional(readOnly = true)
    public List<EtlChainStep> stepsOf(Long chainId) {
        require(chainId);
        return steps.findByChainIdOrderByStepNoAsc(chainId);
    }

    @Transactional
    public EtlChain save(Long id, EtlChain form, List<EtlChainStep> formSteps, String user) {
        EtlChain c = id == null ? new EtlChain() : require(id);
        if (form.getName() == null || form.getName().isBlank()) {
            throw new BadRequestException("Name the chain first");
        }
        c.setName(form.getName().trim());
        c.setDescription(form.getDescription());
        c.setFolder(blankToNull(form.getFolder()));
        c.setEnabled(form.isEnabled());
        if (id == null) c.setCreatedBy(user);
        c.setUpdatedAt(OffsetDateTime.now());
        EtlChain saved = chains.save(c);

        if (formSteps != null) replaceSteps(saved.getId(), formSteps);
        return saved;
    }

    /**
     * Steps are replaced wholesale rather than diffed: the editor hands back the whole ordered
     * list, and renumbering in place would collide with the (chain_id, step_no) uniqueness halfway
     * through. Positions are reassigned 1..n from the given order, so the caller never has to keep
     * step numbers consistent itself.
     */
    private void replaceSteps(Long chainId, List<EtlChainStep> formSteps) {
        steps.deleteByChainId(chainId);
        steps.flush();
        int n = 0;
        for (EtlChainStep s : formSteps) {
            EtlChainStep step = new EtlChainStep();
            step.setChainId(chainId);
            step.setStepNo(++n);
            step.setKind(s.getKind());
            step.setOnFail("continue".equals(s.getOnFail()) ? "continue" : "stop");
            if ("pipeline".equals(s.getKind())) {
                if (s.getPipelineId() == null) throw new BadRequestException("Step " + n + ": no data pipeline selected");
                pipelines.findById(s.getPipelineId())
                        .orElseThrow(() -> new BadRequestException("Step " + step.getStepNo() + ": selected data pipeline not found"));
                step.setPipelineId(s.getPipelineId());
            } else if ("statement".equals(s.getKind())) {
                if (s.getSchedulerId() == null) throw new BadRequestException("Step " + n + ": no SQL statement selected");
                schedulers.findById(s.getSchedulerId())
                        .orElseThrow(() -> new BadRequestException("Step " + step.getStepNo() + ": selected SQL statement not found"));
                step.setSchedulerId(s.getSchedulerId());
            } else if ("check".equals(s.getKind())) {
                if (s.getCheckId() == null) throw new BadRequestException("Step " + n + ": no check set selected");
                checks.findById(s.getCheckId())
                        .orElseThrow(() -> new BadRequestException("Step " + step.getStepNo() + ": selected check set not found"));
                step.setCheckId(s.getCheckId());
            } else if (executors.containsKey(s.getKind())) {
                if (s.getConfig() == null || s.getConfig().isBlank()) {
                    throw new BadRequestException("Step " + n + ": this step is not configured");
                }
                step.setConfig(s.getConfig());
            } else {
                throw new BadRequestException("Step " + n + ": unknown step kind \"" + s.getKind() + "\"");
            }
            step.setLabel(s.getLabel());
            step.setVarName(s.getVarName());
            steps.save(step);
        }
    }

    @Transactional
    public void delete(Long id) {
        require(id);
        chains.deleteById(id);
    }

    // ---- rounds ------------------------------------------------------------

    @Transactional(readOnly = true)
    public List<EtlChainRun> history(Long chainId, int limit) {
        require(chainId);
        return runs.findByChainIdOrderByStartedAtDesc(chainId,
                org.springframework.data.domain.PageRequest.of(0, Math.min(Math.max(limit, 1), 200)));
    }

    @Transactional(readOnly = true)
    public List<EtlChainRunStep> runSteps(Long runId) {
        return runSteps.findByRunIdOrderByStepNoAsc(runId);
    }

    /**
     * Opens a new round and hands the work to the worker thread.
     *
     * <p>The round number is MAX+1 for this chain and year. Two rounds started at the same instant
     * would compute the same number; the unique constraint on (chain, year, round) turns that into
     * a failed insert for the loser rather than two rounds both calling themselves "round 3".
     */
    @Transactional
    public EtlChainRun start(Long chainId, String year, String user) {
        EtlChain c = require(chainId);
        if (!c.isEnabled()) throw new BadRequestException("This chain is disabled");
        List<EtlChainStep> plan = steps.findByChainIdOrderByStepNoAsc(chainId);
        if (plan.isEmpty()) throw new BadRequestException("This chain has no steps yet");

        String y = year == null || year.isBlank() ? null : year.trim();
        if (y != null && !y.matches("\\d{4}")) throw new BadRequestException("Fiscal year must be a 4-digit number");
        Integer max = runs.maxRound(chainId, y);

        EtlChainRun run = new EtlChainRun();
        run.setChainId(chainId);
        run.setFiscalYear(y);
        run.setRoundNo(max == null ? 1 : max + 1);
        // Single worker — a second start queues rather than running in parallel; the status says so.
        run.setStatus("queued");
        run.setRunBy(user);
        final EtlChainRun saved = runs.save(run);

        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() {
                pool.submit(() -> work(saved.getId(), chainId, y, user, 1));
            }
        });
        return saved;
    }

    /**
     * Resume a failed run — opens a new run starting from the original run's "first step not passed".
     * Steps already passed are recorded as skipped with a reason, not silently dropped.
     *
     * <p>Rationale: long chains (10-20 steps of several minutes each) that fail late should not have
     * to restart from step 1 and burn hours to get back to the same point.
     *
     * <p>Deliberate limitation: variables published by earlier steps ({@code {{var}}}) are not replayed
     * in the resumed run — later steps referencing a skipped step's variables see no value, which is
     * more honest than reusing possibly stale values from the old run.
     *
     * <p>For a {@code partial} run (on_fail=continue): passed steps <em>after</em> the first failed
     * step are re-run, not skipped — the chain is ordered and later steps may consume earlier
     * results, so patchy skipping is riskier than re-running. A replace-mode pipeline is idempotent
     * on re-run, but append mode would duplicate data, so that is blocked here.
     */
    @Transactional
    public EtlChainRun resume(Long fromRunId, String user) {
        EtlChainRun prev = runs.findById(fromRunId)
                .orElseThrow(() -> new NotFoundException("Run not found: " + fromRunId));
        if ("running".equals(prev.getStatus()) || "queued".equals(prev.getStatus())) {
            throw new BadRequestException("The previous run has not finished — cancel it or wait for it to finish");
        }
        if ("success".equals(prev.getStatus())) {
            throw new BadRequestException("The previous run passed every step — nothing to resume");
        }
        EtlChain c = require(prev.getChainId());
        if (!c.isEnabled()) throw new BadRequestException("This chain is disabled");
        List<EtlChainStep> plan = steps.findByChainIdOrderByStepNoAsc(prev.getChainId());
        if (plan.isEmpty()) throw new BadRequestException("This chain has no steps yet");

        // The first step not passed is where the resumed run starts. Compared against the chain's
        // current steps (they may have been edited since); a step with no success record counts as not
        // passed. Walk back through the whole resume lineage, not just one run — a resume run records
        // earlier steps as "skipped", not success, so looking at one run would jump back to step 1.
        java.util.Set<Integer> passed = new java.util.HashSet<>();
        Long cursor = fromRunId;
        java.util.Set<Long> seen = new java.util.HashSet<>();
        while (cursor != null && seen.add(cursor)) {
            for (EtlChainRunStep st : runSteps.findByRunIdOrderByStepNoAsc(cursor)) {
                if ("success".equals(st.getStatus())) passed.add(st.getStepNo());
            }
            cursor = runs.findById(cursor).map(EtlChainRun::getResumedFromRunId).orElse(null);
        }
        // First step not passed — every step from there on is re-run, even ones that passed before
        // (the chain is ordered; patchy skipping is riskier than re-running).
        int startAt = plan.stream().map(EtlChainStep::getStepNo)
                .filter(n -> !passed.contains(n))
                .min(Integer::compareTo)
                .orElseThrow(() -> new BadRequestException("Every step of the chain has passed — nothing to resume"));

        // Pipeline steps in append/upsert mode inside the re-run range risk duplicate data.
        List<String> risky = new ArrayList<>();
        for (EtlChainStep st : plan) {
            if (st.getStepNo() < startAt || !"pipeline".equals(st.getKind()) || st.getPipelineId() == null) continue;
            pipelines.findById(st.getPipelineId()).ifPresent(pl -> {
                if (!"replace".equals(pl.getLoadMode())) risky.add("step " + st.getStepNo() + " " + pl.getName());
            });
        }
        if (!risky.isEmpty()) {
            throw new BadRequestException("Cannot resume — these steps append data (append/upsert) "
                    + "and re-running would duplicate it: " + String.join(", ", risky) + ". Re-run the whole chain instead.");
        }

        Integer max = runs.maxRound(prev.getChainId(), prev.getFiscalYear());
        EtlChainRun run = new EtlChainRun();
        run.setChainId(prev.getChainId());
        run.setFiscalYear(prev.getFiscalYear());
        run.setRoundNo(max == null ? 1 : max + 1);
        run.setStatus("queued");
        run.setRunBy(user);
        run.setResumedFromRunId(fromRunId);
        run.setStartStepNo(startAt);
        final EtlChainRun saved = runs.save(run);
        final Long chainId = prev.getChainId();
        final String y = prev.getFiscalYear();
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() {
                pool.submit(() -> work(saved.getId(), chainId, y, user, startAt));
            }
        });
        return saved;
    }

    /**
     * Walks the steps in order. A step that fails ends the round unless it is marked
     * {@code continue}; the remaining steps are then recorded as skipped rather than left absent,
     * so the round shows what did not happen as well as what did.
     *
     * <p>A check that returns more bad rows than it tolerates counts as a failure here. That is the
     * point of putting a check in a chain — it is a gate, not a report.
     */
    private void work(Long runId, Long chainId, String year, String user, int startStepNo) {
        // A run cancelled while still queued is already closed — don't run it. A queued run moves to running here.
        boolean proceed = Boolean.TRUE.equals(tx.execute(s -> {
            EtlChainRun r = runs.findById(runId).orElse(null);
            if (r == null || "cancelled".equals(r.getStatus())) return false;
            if ("queued".equals(r.getStatus())) { r.setStatus("running"); runs.save(r); }
            return true;
        }));
        if (!proceed) { cancelFlags.remove(runId); return; }
        List<EtlChainStep> plan = tx.execute(s -> steps.findByChainIdOrderByStepNoAsc(chainId));
        if (plan == null) return;
        java.util.concurrent.atomic.AtomicBoolean cancelFlag =
                cancelFlags.computeIfAbsent(runId, k -> new java.util.concurrent.atomic.AtomicBoolean());
        boolean anyFailed = false;
        boolean stopped = false;
        boolean cancelled = false;
        StepContext ctx = new StepContext(year, user);

        for (EtlChainStep step : plan) {
            // Resume: steps passed in the original run are skipped — recorded so it is visible, not silent.
            if (step.getStepNo() < startStepNo) {
                // Shown as passed (it did pass, in the run this one resumes) rather than skipped.
                record(runId, step, "success", null, "Passed in the previous run (not re-run)");
                continue;
            }
            // Check the flag before every new step. A step already running is stopped through
            // WarehouseCancelRegistry; this only stops the chain from moving on.
            if (!cancelled && cancelFlag.get()) cancelled = true;
            if (cancelled) {
                record(runId, step, "skipped", null, "Not run — the whole chain was cancelled");
                continue;
            }
            if (stopped) {
                record(runId, step, "skipped", null, "Not run because a previous step failed");
                continue;
            }
            String name = nameOf(step);
            // Write the running row before starting — steps that take many minutes need something on
            // screen meanwhile (previously the result row was written only when the step finished).
            EtlChainRunStep rec = base(runId, step, name);
            rec.setStatus("running");
            tx.executeWithoutResult(s -> runSteps.save(rec));
            try {
                if ("pipeline".equals(step.getKind())) {
                    WarehouseRun r = warehouse.runInline(step.getPipelineId(), user, year);
                    // Totals not matching the source = step failed — the control-total gate is why a control column exists.
                    // Fail closed: "error" (could not compare, e.g. a mistyped column name) also fails.
                    // A gate that opens when it breaks is a gate silently switched off.
                    boolean ok = "ok".equals(r.getStatus())
                            && !"mismatch".equals(r.getReconStatus())
                            && !"error".equals(r.getReconStatus());
                    boolean wasCancelled = "cancelled".equals(r.getStatus());
                    rec.setStatus(ok ? "success" : "failed");
                    rec.setRowsRead(r.getRowsRead());
                    rec.setRowsWritten(r.getRowsWritten());
                    rec.setWarehouseRunId(r.getId());
                    rec.setMessage(r.getMessage());
                    // A cancelled step (from the Data Warehouse screen or a chain-wide cancel) stops the whole chain
                    // regardless of on_fail — carrying on and reporting "all passed" when a middle step never
                    // actually loaded is the most dangerous kind of wrong answer.
                    if (wasCancelled) { cancelled = true; anyFailed = true; }
                    else if (!ok) { anyFailed = true; stopped = "stop".equals(step.getOnFail()); }
                } else if ("statement".equals(step.getKind())) {
                    SchedulerRun r = tx.execute(s -> schedulerService.runInline(step.getSchedulerId(), user, year));
                    boolean ok = r != null && "ok".equals(r.getStatus());
                    rec.setStatus(ok ? "success" : "failed");
                    rec.setAffected(r == null ? null : r.getAffected());
                    rec.setSchedulerRunId(r == null ? null : r.getId());
                    rec.setMessage(r == null ? "The statement returned no result" : r.getMessage());
                    if (!ok) { anyFailed = true; stopped = "stop".equals(step.getOnFail()); }
                } else if (executors.containsKey(step.getKind())) {
                    ChainStepExecutor ex = executors.get(step.getKind());
                    @SuppressWarnings("unchecked")
                    Map<String, Object> cfg = step.getConfig() == null
                            ? Map.of() : json.readValue(step.getConfig(), Map.class);
                    StepResult res = ex.run(cfg, ctx);
                    ctx.publish(step.getVarName() != null ? step.getVarName() : "step" + step.getStepNo(),
                            res.output());
                    rec.setStatus(res.ok() ? "success" : "failed");
                    rec.setRowsRead(res.rowsRead());
                    rec.setAffected(res.affected());
                    rec.setMessage(prefixYear(year, res.message()));
                    if (!res.ok()) { anyFailed = true; stopped = "stop".equals(step.getOnFail()); }
                } else {
                    // runInline, not runNow: the latter moves to the background and returns a running row
                    // immediately, so the gate would read the result before the check finished and always fail.
                    DataCheckRun r = tx.execute(s -> checkService.runInline(step.getCheckId(), user, year));
                    boolean pass = r != null && "pass".equals(r.getStatus());
                    rec.setStatus(pass ? "success" : "failed");
                    rec.setCheckCount(r == null ? null : r.getRowCount());
                    rec.setCheckPass(pass);
                    rec.setDataCheckRunId(r == null ? null : r.getId());
                    rec.setMessage(r == null ? "The check set returned no result" : r.getMessage());
                    if (!pass) { anyFailed = true; stopped = "stop".equals(step.getOnFail()); }
                }
            } catch (Exception e) {
                rec.setStatus("failed");
                rec.setMessage(WarehouseService.friendly(rootMessage(e)));
                anyFailed = true;
                stopped = "stop".equals(step.getOnFail());
            }
            rec.setFinishedAt(OffsetDateTime.now());
            tx.executeWithoutResult(s -> runSteps.save(rec));
        }

        // Read the flag again — a cancel during the last step has no further loop iteration to see it.
        if (!cancelled && cancelFlag.get()) cancelled = true;
        cancelFlags.remove(runId);
        final String status = cancelled ? "cancelled"
                : !anyFailed ? "success" : (stopped ? "failed" : "partial");
        tx.executeWithoutResult(s -> {
            EtlChainRun r = runs.findById(runId).orElse(null);
            if (r == null) return;
            r.setStatus(status);
            r.setFinishedAt(OffsetDateTime.now());
            r.setMessage("cancelled".equals(status) ? "Cancelled by user · " + summary(runId, "failed")
                                                    : summary(runId, status));
            runs.save(r);
        });
    }

    /**
     * Cancel a whole run: a queued run is closed immediately; a running run gets a flag to stop before
     * the next step, and the pipeline step in flight is stopped down to its database statement (via the warehouse registry).
     */
    public EtlChainRun cancel(Long runId) {
        EtlChainRun r = tx.execute(s -> runs.findById(runId).orElse(null));
        if (r == null) throw new NotFoundException("Run not found: " + runId);
        if (!"queued".equals(r.getStatus()) && !"running".equals(r.getStatus())) {
            throw new BadRequestException("This run has already finished (" + r.getStatus() + ") — nothing to cancel");
        }
        cancelFlags.computeIfAbsent(runId, k -> new java.util.concurrent.atomic.AtomicBoolean()).set(true);
        if ("queued".equals(r.getStatus())) {
            tx.executeWithoutResult(s -> runs.findById(runId).ifPresent(rr -> {
                if (!"queued".equals(rr.getStatus())) return;   // the worker just picked it up — let the flag handle it
                rr.setStatus("cancelled");
                rr.setMessage("Cancelled before it started");
                rr.setFinishedAt(OffsetDateTime.now());
                runs.save(rr);
            }));
        } else {
            // Step in flight: the chain runs one step at a time on a single worker, so there can be only
            // one running warehouse run with trigger=chain — this run's.
            warehouse.cancelActiveChainRun();
        }
        return tx.execute(s -> runs.findById(runId).orElse(r));
    }

    private static String prefixYear(String year, String msg) {
        return (year == null || year.isBlank() ? "" : "Year " + year + " · ") + msg;
    }

    private String summary(Long runId, String status) {
        List<EtlChainRunStep> done = runSteps.findByRunIdOrderByStepNoAsc(runId);
        long ok = done.stream().filter(s -> "success".equals(s.getStatus())).count();
        long bad = done.stream().filter(s -> "failed".equals(s.getStatus())).count();
        long skip = done.stream().filter(s -> "skipped".equals(s.getStatus())).count();
        return switch (status) {
            case "success" -> "Passed all " + ok + " steps";
            case "partial" -> "Passed " + ok + " · failed " + bad + " (set to continue)";
            default -> "Stopped at a failed step · passed " + ok + " · failed " + bad + " · not run " + skip;
        };
    }

    private EtlChainRunStep base(Long runId, EtlChainStep step, String name) {
        EtlChainRunStep rec = new EtlChainRunStep();
        rec.setRunId(runId);
        rec.setStepNo(step.getStepNo());
        rec.setKind(step.getKind());
        rec.setRefName(name);
        return rec;
    }

    private void record(Long runId, EtlChainStep step, String status, String name, String message) {
        EtlChainRunStep rec = base(runId, step, name != null ? name : nameOf(step));
        rec.setStatus(status);
        rec.setMessage(message);
        rec.setFinishedAt(OffsetDateTime.now());
        tx.executeWithoutResult(s -> runSteps.save(rec));
    }

    private String nameOf(EtlChainStep step) {
        try {
            if (executors.containsKey(step.getKind())) {
                return step.getLabel() != null && !step.getLabel().isBlank()
                        ? step.getLabel() : executors.get(step.getKind()).label();
            }
            return tx.execute(s -> switch (step.getKind()) {
                case "pipeline" -> pipelines.findById(step.getPipelineId()).map(WarehousePipeline::getName).orElse(null);
                case "statement" -> schedulers.findById(step.getSchedulerId()).map(Scheduler::getName).orElse(null);
                default -> checks.findById(step.getCheckId()).map(DataCheck::getName).orElse(null);
            });
        } catch (Exception e) {
            return null;
        }
    }

    /** Which chains use this pipeline/check — so a delete can say what is in the way. */
    @Transactional(readOnly = true)
    public List<String> usedBy(Long pipelineId, Long checkId, Long schedulerId) {
        List<EtlChainStep> hits = pipelineId != null ? steps.findByPipelineId(pipelineId)
                : checkId != null ? steps.findByCheckId(checkId)
                : steps.findBySchedulerId(schedulerId);
        List<String> names = new ArrayList<>();
        for (EtlChainStep s : hits) {
            chains.findById(s.getChainId()).map(EtlChain::getName).ifPresent(names::add);
        }
        return names;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    private static String rootMessage(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null && t.getCause() != t) t = t.getCause();
        return t.getMessage() == null ? t.toString() : t.getMessage();
    }
}
