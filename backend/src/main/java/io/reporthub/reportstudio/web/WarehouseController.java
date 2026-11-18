package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;

import java.util.Map;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.domain.WarehousePipeline;
import io.reporthub.reportstudio.domain.WarehouseRun;
import io.reporthub.reportstudio.service.WarehouseService;

import java.time.OffsetDateTime;
import java.util.List;

/** Data-warehouse ETL pipelines: CRUD, enable/disable, manual run, and run history. */
@RestController
public class WarehouseController {

    public record PipelineDto(Long id, String name, String description, String folder,
                              String sourceDatasourceId, String sourceSql, String fiscalYear,
                              String targetDatasourceId, String targetSchema, String targetTable,
                              String loadMode, String clearMode, String clearWhere, String paramsJson,
                              String keyColumns, boolean autoCreate,
                              boolean addColumns,
                              String controlColumn, java.math.BigDecimal controlTolerance,
                              String cron, boolean enabled, OffsetDateTime nextRunAt,
                              OffsetDateTime lastRunAt, String lastStatus, String lastError,
                              Integer lastRowsRead, Integer lastRowsWritten,
                              String createdBy, OffsetDateTime createdAt) {}
    public record RunDto(Long id, Long pipelineId, OffsetDateTime startedAt, OffsetDateTime finishedAt,
                         String status, String trigger, Integer rowsRead, Integer rowsWritten,
                         String message, String runBy,
                         Long srcRows, Long tgtRows, java.math.BigDecimal srcSum,
                         java.math.BigDecimal tgtSum, String reconStatus, String reconMessage) {}
    public record SaveRequest(@NotBlank String name, String description, String folder,
                              String sourceDatasourceId, @NotBlank String sourceSql, String fiscalYear,
                              String targetDatasourceId, String targetSchema, @NotBlank String targetTable,
                              String loadMode, String clearMode, String clearWhere, String paramsJson,
                              String keyColumns, Boolean autoCreate,
                              Boolean addColumns,
                              String controlColumn, java.math.BigDecimal controlTolerance,
                              String cron, Boolean enabled) {}
    public record ToggleRequest(boolean enabled) {}
    public record PreviewRequest(String datasourceId, @NotBlank String sql, String year, Integer limit) {}

    private static String blankToNull(String v) {
        return v == null || v.isBlank() ? null : v.trim();
    }

    private final WarehouseService service;

    private final io.reporthub.reportstudio.service.QueryQueueService queue;

    public WarehouseController(WarehouseService service,
                               io.reporthub.reportstudio.service.QueryQueueService queue) {
        this.service = service;
        this.queue = queue;
    }

    @GetMapping("/warehouse/pipelines")
    public List<PipelineDto> list() {
        return service.list().stream().map(WarehouseController::toDto).toList();
    }

    @GetMapping("/warehouse/pipelines/{id}")
    public PipelineDto get(@PathVariable Long id) {
        return toDto(service.require(id));
    }

    @PostMapping("/warehouse/pipelines")
    @ResponseStatus(HttpStatus.CREATED)
    public PipelineDto create(@Valid @RequestBody SaveRequest req, Authentication auth) {
        return toDto(service.save(null, fromReq(req), auth == null ? "system" : auth.getName()));
    }

    @PutMapping("/warehouse/pipelines/{id}")
    public PipelineDto update(@PathVariable Long id, @Valid @RequestBody SaveRequest req) {
        return toDto(service.save(id, fromReq(req), null));
    }

    @PostMapping("/warehouse/pipelines/{id}/toggle")
    public PipelineDto toggle(@PathVariable Long id, @RequestBody ToggleRequest req) {
        return toDto(service.setEnabled(id, req.enabled()));
    }

    /** @param year the fiscal year the portal is set to; falls back to the pipeline's own when absent. */
    /**
     * @param body values for the parameters this pipeline declares, {@code {"STAGE":"4.4"}}.
     *             Optional — a pipeline with no parameters is run with an empty body, as before.
     */
    @PostMapping("/warehouse/pipelines/{id}/run")
    public RunDto run(@PathVariable Long id,
                      @RequestParam(required = false) String year,
                      @RequestBody(required = false) Map<String, String> body,
                      Authentication auth) {
        Map<String, String> params = body == null ? new java.util.LinkedHashMap<>() : new java.util.LinkedHashMap<>(body);
        // the fiscal year travels as its own field, so it never lands in the $NAME substitution
        String y = year != null && !year.isBlank() ? year : params.remove("year");
        return toRunDto(service.runNow(id, auth == null ? "system" : auth.getName(), y, params));
    }

    /**
     * Look at what the source SQL returns before any of it is written to a target.
     *
     * <p>Always queued — real pipeline source queries take minutes, which cannot survive a reverse
     * proxy that cuts requests idle for ~50 seconds. The caller gets a job id back and polls for status.
     */
    @PostMapping("/warehouse/preview")
    public Map<String, String> preview(@Valid @RequestBody PreviewRequest req) {
        String id = queue.submit(() -> service.preview(blankToNull(req.datasourceId()), req.sql(),
                req.year(), req.limit() == null ? 100 : req.limit()));
        return Map.of("id", id, "status", "running");
    }

    /** Poll the result of a queued preview. */
    @GetMapping("/warehouse/preview/result/{id}")
    public io.reporthub.reportstudio.service.QueryQueueService.Job previewResult(@PathVariable String id) {
        return queue.get(id);
    }

    /** Row count actually sitting in the target — the last run's status can be days stale. */
    @GetMapping("/warehouse/pipelines/{id}/target")
    public WarehouseService.TargetInfo target(@PathVariable Long id) {
        return service.targetInfo(id);
    }

    /**
     * Cancel one job — a queued job is withdrawn; a running job is stopped down to its database
     * statement (otherwise a job stuck on a blocked database could not be stopped from the screen).
     */
    @PostMapping("/warehouse/runs/{runId}/cancel")
    public RunDto cancelRun(@PathVariable Long runId) {
        return toRunDto(service.cancelRun(runId));
    }

    public record StepDto(Long id, int stepNo, String kind, String label, String config,
                          String onFail, String varName) {}
    public record RunStepDto(Long id, int stepNo, String kind, String label, String status,
                             Integer rowsRead, Integer rowsWritten, Integer affected, String message,
                             OffsetDateTime startedAt, OffsetDateTime finishedAt) {}

    public record RecentRunDto(Long pipelineId, String status, Long seconds, Integer rowsWritten,
                              OffsetDateTime startedAt) {}

    /**
     * Latest run of every pipeline in one request — the home screen draws a history strip on every card.
     *
     * <p>Asking per pipeline would mean one request per pipeline on each screen open, the same pattern
     * that once overloaded the database — read once and distribute client-side.
     */
    @GetMapping("/warehouse/runs/recent")
    public List<RecentRunDto> recentRuns(@RequestParam(defaultValue = "12") int perPipeline) {
        return service.recentRuns(Math.min(Math.max(perPipeline, 1), 30)).stream()
                .map(r -> new RecentRunDto(r.getPipelineId(), r.getStatus(),
                        r.getFinishedAt() == null ? null
                                : java.time.Duration.between(r.getStartedAt(), r.getFinishedAt()).toSeconds(),
                        r.getRowsWritten(), r.getStartedAt()))
                .toList();
    }

    /** Step kinds offered by the editor — adding a backend executor makes it appear on screen automatically. */
    @GetMapping("/warehouse/step-types")
    public List<java.util.Map<String, String>> stepTypes() {
        return service.stepTypes();
    }

    /** The step list of one pipeline. */
    @GetMapping("/warehouse/pipelines/{id}/steps")
    public List<StepDto> steps(@PathVariable Long id) {
        return service.stepsOf(id).stream()
                .map(x -> new StepDto(x.getId(), x.getStepNo(), x.getKind(), x.getLabel(),
                        x.getConfig(), x.getOnFail(), x.getVarName())).toList();
    }

    /** Overwrite the whole step list — order in the body is execution order. */
    @PutMapping("/warehouse/pipelines/{id}/steps")
    public List<StepDto> saveSteps(@PathVariable Long id, @RequestBody List<StepDto> body) {
        service.saveSteps(id, body.stream().map(d -> {
            var st = new io.reporthub.reportstudio.domain.WarehousePipelineStep();
            st.setKind(d.kind());
            st.setLabel(d.label());
            st.setConfig(d.config());
            st.setOnFail(d.onFail());
            st.setVarName(d.varName());
            return st;
        }).toList());
        return steps(id);
    }

    /** Per-step results of one run — used by the screen to draw progress while running. */
    @GetMapping("/warehouse/runs/{runId}/steps")
    public List<RunStepDto> runSteps(@PathVariable Long runId) {
        return service.runStepsOf(runId).stream()
                .map(x -> new RunStepDto(x.getId(), x.getStepNo(), x.getKind(), x.getLabel(), x.getStatus(),
                        x.getRowsRead(), x.getRowsWritten(), x.getAffected(), x.getMessage(),
                        x.getStartedAt(), x.getFinishedAt())).toList();
    }

    /** One run with its per-station results — what the flow diagram replays. */
    public record RunDetailDto(RunDto run, List<RunStepDto> steps) {}

    @GetMapping("/warehouse/runs/{runId:\\d+}")
    public RunDetailDto run(@PathVariable Long runId) {
        return new RunDetailDto(toRunDto(service.run(runId)), runSteps(runId));
    }

    /** Latest run of a pipeline with its stations; 204 when it has never run. */
    @GetMapping("/warehouse/pipelines/{id}/runs/latest")
    public org.springframework.http.ResponseEntity<RunDetailDto> latestRun(@PathVariable Long id) {
        var list = service.history(id, 1);
        if (list.isEmpty()) return org.springframework.http.ResponseEntity.noContent().build();
        return org.springframework.http.ResponseEntity.ok(run(list.get(0).getId()));
    }

    @GetMapping("/warehouse/pipelines/{id}/runs")
    public List<RunDto> runs(@PathVariable Long id, @RequestParam(defaultValue = "30") int limit) {
        return service.history(id, limit).stream().map(WarehouseController::toRunDto).toList();
    }

    @DeleteMapping("/warehouse/pipelines/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        service.delete(id);
    }

    private static WarehousePipeline fromReq(SaveRequest req) {
        WarehousePipeline p = new WarehousePipeline();
        p.setName(req.name());
        p.setDescription(req.description());
        p.setFolder(blankToNull(req.folder()));
        p.setSourceDatasourceId(req.sourceDatasourceId());
        p.setSourceSql(req.sourceSql());
        p.setFiscalYear(blankToNull(req.fiscalYear()));
        p.setTargetSchema(blankToNull(req.targetSchema()));
        p.setTargetDatasourceId(req.targetDatasourceId());
        p.setTargetTable(req.targetTable());
        p.setLoadMode(req.loadMode() == null || req.loadMode().isBlank() ? "replace" : req.loadMode().trim());
        p.setClearMode(req.clearMode() == null || req.clearMode().isBlank() ? "delete" : req.clearMode().trim());
        p.setClearWhere(blankToNull(req.clearWhere()));
        p.setControlColumn(blankToNull(req.controlColumn()));
        p.setControlTolerance(req.controlTolerance());
        p.setParamsJson(blankToNull(req.paramsJson()));
        p.setKeyColumns(req.keyColumns());
        p.setAutoCreate(req.autoCreate() == null || req.autoCreate());
        p.setAddColumns(Boolean.TRUE.equals(req.addColumns()));
        p.setCron(req.cron());
        p.setEnabled(req.enabled() == null || req.enabled());
        return p;
    }

    private static PipelineDto toDto(WarehousePipeline p) {
        return new PipelineDto(p.getId(), p.getName(), p.getDescription(), p.getFolder(),
                p.getSourceDatasourceId(), p.getSourceSql(), p.getFiscalYear(),
                p.getTargetDatasourceId(), p.getTargetSchema(), p.getTargetTable(),
                p.getLoadMode(), p.getClearMode(), p.getClearWhere(), p.getParamsJson(),
                p.getKeyColumns(), p.isAutoCreate(), p.isAddColumns(),
                p.getControlColumn(), p.getControlTolerance(),
                p.getCron(), p.isEnabled(),
                p.getNextRunAt(), p.getLastRunAt(), p.getLastStatus(), p.getLastError(),
                p.getLastRowsRead(), p.getLastRowsWritten(), p.getCreatedBy(), p.getCreatedAt());
    }

    private static RunDto toRunDto(WarehouseRun r) {
        return new RunDto(r.getId(), r.getPipelineId(), r.getStartedAt(), r.getFinishedAt(),
                r.getStatus(), r.getTrigger(), r.getRowsRead(), r.getRowsWritten(), r.getMessage(), r.getRunBy(),
                r.getSrcRows(), r.getTgtRows(), r.getSrcSum(), r.getTgtSum(),
                r.getReconStatus(), r.getReconMessage());
    }
}
