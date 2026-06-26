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
import io.reporthub.reportstudio.domain.AdhocRunLog;
import io.reporthub.reportstudio.domain.DatasetDef;
import io.reporthub.reportstudio.repo.AdhocRunLogRepository;
import io.reporthub.reportstudio.repo.DatasetDefRepository;
import io.reporthub.reportstudio.service.DatasetService;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/** User-defined datasets: SQL editor CRUD, preview, fields, distinct values and aggregation. */
@RestController
public class DatasetController {

    public record DatasetDto(Long id, String name, String description, String datasourceId,
                             String sqlText, String captureMode, OffsetDateTime capturedAt,
                             Integer captureRows, String createdBy, OffsetDateTime createdAt) {}
    public record SaveDatasetRequest(@NotBlank String name, String description,
                                     String datasourceId, @NotBlank String sqlText) {}
    public record PreviewRequest(String datasourceId, @NotBlank String sql) {}
    public record AggregateRequest(List<String> dims, List<String> measures, Map<String, String> filters) {}

    private final DatasetDefRepository repo;
    private final DatasetService service;
    private final AdhocRunLogRepository runLog;

    public DatasetController(DatasetDefRepository repo, DatasetService service,
                             AdhocRunLogRepository runLog) {
        this.repo = repo;
        this.service = service;
        this.runLog = runLog;
    }

    @GetMapping("/datasets")
    public List<DatasetDto> list() {
        return repo.findAllByOrderByCreatedAtDesc().stream().map(DatasetController::toDto).toList();
    }

    @PostMapping("/datasets")
    @ResponseStatus(HttpStatus.CREATED)
    public DatasetDto create(@Valid @RequestBody SaveDatasetRequest req, Authentication auth) {
        DatasetService.validateSql(req.sqlText());
        DatasetDef d = new DatasetDef();
        apply(d, req);
        d.setCreatedBy(auth == null ? "system" : auth.getName());
        d.setCreatedAt(OffsetDateTime.now());
        return toDto(repo.save(d));
    }

    @PutMapping("/datasets/{id}")
    public DatasetDto update(@PathVariable Long id, @Valid @RequestBody SaveDatasetRequest req) {
        DatasetService.validateSql(req.sqlText());
        DatasetDef d = service.require(id);
        apply(d, req);
        return toDto(repo.save(d));
    }

    @DeleteMapping("/datasets/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        repo.delete(service.require(id));
    }

    /** Materialize the source query into a local snapshot (capture) — max 100k rows. */
    @PostMapping("/datasets/{id}/capture")
    public DatasetDto capture(@PathVariable Long id) {
        return toDto(service.capture(service.require(id), 100_000));
    }

    /** Drop the snapshot and go back to live querying. */
    @DeleteMapping("/datasets/{id}/capture")
    public DatasetDto uncapture(@PathVariable Long id) {
        return toDto(service.uncapture(service.require(id)));
    }

    /** Editor preview — run the SQL (limited) and return columns + rows. */
    @PostMapping("/datasets/preview")
    public DatasetService.TableResult preview(@Valid @RequestBody PreviewRequest req) {
        return service.preview(req.datasourceId(), req.sql(), 200);
    }

    @GetMapping("/datasets/{id}/fields")
    public List<DatasetService.Column> fields(@PathVariable Long id) {
        return service.fields(service.require(id));
    }

    @GetMapping("/datasets/{id}/distinct")
    public List<String> distinct(@PathVariable Long id, @RequestParam String field) {
        return service.distinct(service.require(id), field);
    }

    /** Ad-hoc aggregation over the dataset (logged like warehouse ad-hoc runs). */
    @PostMapping("/datasets/{id}/aggregate")
    public DatasetService.TableResult aggregate(@PathVariable Long id,
                                                @RequestBody AggregateRequest req,
                                                Authentication auth) {
        DatasetDef d = service.require(id);
        DatasetService.TableResult result = service.aggregate(d,
                req.dims() == null ? List.of() : req.dims(),
                req.measures() == null ? List.of() : req.measures(),
                req.filters());
        try {
            AdhocRunLog log = new AdhocRunLog();
            log.setDataset("dataset:" + d.getName());
            log.setFields(String.join(",", req.dims() == null ? List.of() : req.dims())
                    + "|" + String.join(",", req.measures() == null ? List.of() : req.measures()));
            log.setFilters(req.filters() == null ? null : req.filters().toString());
            log.setRowCount(result.rowCount());
            log.setCreatedBy(auth == null ? "anonymous" : auth.getName());
            log.setCreatedAt(OffsetDateTime.now());
            runLog.save(log);
        } catch (Exception ignored) { /* best effort */ }
        return result;
    }

    private static void apply(DatasetDef d, SaveDatasetRequest req) {
        d.setName(req.name().trim());
        d.setDescription(req.description());
        d.setDatasourceId(req.datasourceId() == null || req.datasourceId().isBlank() ? null : req.datasourceId());
        d.setSqlText(req.sqlText().trim());
    }

    private static DatasetDto toDto(DatasetDef d) {
        return new DatasetDto(d.getId(), d.getName(), d.getDescription(), d.getDatasourceId(),
                d.getSqlText(), d.getCaptureMode(), d.getCapturedAt(), d.getCaptureRows(),
                d.getCreatedBy(), d.getCreatedAt());
    }
}
