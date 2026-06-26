package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
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

    public record PipelineDto(Long id, String name, String description,
                              String sourceDatasourceId, String sourceSql,
                              String targetDatasourceId, String targetTable,
                              String loadMode, String keyColumns, boolean autoCreate,
                              String cron, boolean enabled, OffsetDateTime nextRunAt,
                              OffsetDateTime lastRunAt, String lastStatus, String lastError,
                              Integer lastRowsRead, Integer lastRowsWritten,
                              String createdBy, OffsetDateTime createdAt) {}
    public record RunDto(Long id, Long pipelineId, OffsetDateTime startedAt, OffsetDateTime finishedAt,
                         String status, String trigger, Integer rowsRead, Integer rowsWritten,
                         String message, String runBy) {}
    public record SaveRequest(@NotBlank String name, String description,
                              String sourceDatasourceId, @NotBlank String sourceSql,
                              String targetDatasourceId, @NotBlank String targetTable,
                              String loadMode, String keyColumns, Boolean autoCreate,
                              String cron, Boolean enabled) {}
    public record ToggleRequest(boolean enabled) {}

    private final WarehouseService service;

    public WarehouseController(WarehouseService service) {
        this.service = service;
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

    @PostMapping("/warehouse/pipelines/{id}/run")
    public RunDto run(@PathVariable Long id, Authentication auth) {
        return toRunDto(service.runNow(id, auth == null ? "system" : auth.getName()));
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
        p.setSourceDatasourceId(req.sourceDatasourceId());
        p.setSourceSql(req.sourceSql());
        p.setTargetDatasourceId(req.targetDatasourceId());
        p.setTargetTable(req.targetTable());
        p.setLoadMode(req.loadMode() == null || req.loadMode().isBlank() ? "replace" : req.loadMode().trim());
        p.setKeyColumns(req.keyColumns());
        p.setAutoCreate(req.autoCreate() == null || req.autoCreate());
        p.setCron(req.cron());
        p.setEnabled(req.enabled() == null || req.enabled());
        return p;
    }

    private static PipelineDto toDto(WarehousePipeline p) {
        return new PipelineDto(p.getId(), p.getName(), p.getDescription(),
                p.getSourceDatasourceId(), p.getSourceSql(), p.getTargetDatasourceId(), p.getTargetTable(),
                p.getLoadMode(), p.getKeyColumns(), p.isAutoCreate(), p.getCron(), p.isEnabled(),
                p.getNextRunAt(), p.getLastRunAt(), p.getLastStatus(), p.getLastError(),
                p.getLastRowsRead(), p.getLastRowsWritten(), p.getCreatedBy(), p.getCreatedAt());
    }

    private static RunDto toRunDto(WarehouseRun r) {
        return new RunDto(r.getId(), r.getPipelineId(), r.getStartedAt(), r.getFinishedAt(),
                r.getStatus(), r.getTrigger(), r.getRowsRead(), r.getRowsWritten(), r.getMessage(), r.getRunBy());
    }
}
