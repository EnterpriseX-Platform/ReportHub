package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
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

    public record DatasetDto(Long id, String name, String description, String folder, String datasourceId,
                             String sqlText, String captureMode, OffsetDateTime capturedAt,
                             Integer captureRows, String createdBy, OffsetDateTime createdAt,
                             String dimensionColumns) {}
    public record SaveDatasetRequest(@NotBlank String name, String description, String folder,
                                     String datasourceId, @NotBlank String sqlText, String dimensionColumns) {}
    /** @param datasetId set when previewing an existing dataset: its row filters for the caller apply */
    public record PreviewRequest(String datasourceId, @NotBlank String sql, Long datasetId) {}
    /** @param agg sum (default) | avg | min | max | count, applied to every measure */
    public record AggregateRequest(List<String> dims, List<String> measures, Map<String, String> filters, String agg) {}

    private final DatasetDefRepository repo;
    private final DatasetService service;
    private final AdhocRunLogRepository runLog;
    private final io.reporthub.reportstudio.analytics.XlsxExporter xlsx;

    public DatasetController(DatasetDefRepository repo, DatasetService service,
                             AdhocRunLogRepository runLog,
                             io.reporthub.reportstudio.analytics.XlsxExporter xlsx) {
        this.repo = repo;
        this.service = service;
        this.runLog = runLog;
        this.xlsx = xlsx;
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.acl.AclService acl;

    @GetMapping("/datasets")
    public List<DatasetDto> list() {
        var all = repo.findAllByOrderByCreatedAtDesc();
        if (acl != null) all = acl.filter("DATASET", all, d -> String.valueOf(d.getId()), "view");
        return all.stream().map(DatasetController::toDto).toList();
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
        var p = io.reporthub.reportstudio.iam.CurrentPrincipal.get().orElse(null);
        boolean admin = p != null && p.admin();
        if (!admin) {
            // Never the application's own database for non-admins, and the datasource's ACL applies.
            if (req.datasourceId() == null || req.datasourceId().isBlank()) {
                throw new org.springframework.web.server.ResponseStatusException(HttpStatus.FORBIDDEN,
                        "Choose a datasource - the internal database cannot be queried here");
            }
            if (acl != null && !acl.allowed("DATASOURCE", req.datasourceId(), "view")) {
                throw new org.springframework.web.server.ResponseStatusException(HttpStatus.FORBIDDEN,
                        "No access to datasource " + req.datasourceId());
            }
        }
        if (req.datasetId() != null) {
            DatasetDef d = service.require(req.datasetId());
            if (acl != null && !acl.allowed("DATASET", String.valueOf(d.getId()), "run")) {
                throw new org.springframework.web.server.ResponseStatusException(HttpStatus.FORBIDDEN,
                        "No run access to dataset " + d.getId());
            }
            boolean canEdit = admin || io.reporthub.reportstudio.iam.PermissionService.can(p, "RH.DATASET", "update");
            // Users who may not edit the dataset preview its saved SQL, never text they typed.
            String sql = canEdit ? req.sql() : d.getSqlText();
            return service.previewFiltered(req.datasourceId(), sql, d.getId(), 200);
        }
        // Free SQL against a datasource = authoring: needs create or update on datasets.
        if (!admin && !(io.reporthub.reportstudio.iam.PermissionService.can(p, "RH.DATASET", "create")
                || io.reporthub.reportstudio.iam.PermissionService.can(p, "RH.DATASET", "update"))) {
            throw new org.springframework.web.server.ResponseStatusException(HttpStatus.FORBIDDEN,
                    "Ad-hoc SQL preview needs create or update permission on datasets");
        }
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
                req.filters(), DatasetService.SCREEN_ROWS, req.agg());
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

    /**
     * Export a dataset result to Excel.
     *
     * <p>The Ad-hoc screen used to disable "Export to Excel" for user-defined datasets because
     * it called {@code /adhoc/export}, which hard-codes {@code dataset:"fact"},
     * so newly added datasets could not be exported at all.
     *
     * <p>This uses the same {@code service.aggregate(...)} as the Run button and converts to xlsx
     * with the existing {@code XlsxExporter.adhoc(...)} — so the file always matches the screen.
     */
    @PostMapping("/datasets/{id}/export")
    public ResponseEntity<byte[]> export(@PathVariable Long id,
                                         @RequestBody AggregateRequest req,
                                         Authentication auth) {
        DatasetDef d = service.require(id);
        List<String> dims = req.dims() == null ? List.of() : req.dims();
        List<String> measures = req.measures() == null ? List.of() : req.measures();
        DatasetService.TableResult t = service.aggregate(d, dims, measures, req.filters(),
                DatasetService.EXPORT_ROWS);

        // TableResult rows are List<Object> in column order; XlsxExporter takes a Map of column name -> value
        List<Map<String, Object>> rows = new java.util.ArrayList<>(t.rows().size());
        for (List<Object> r : t.rows()) {
            Map<String, Object> m = new java.util.LinkedHashMap<>();
            for (int i = 0; i < t.columns().size() && i < r.size(); i++) m.put(t.columns().get(i), r.get(i));
            rows.add(m);
        }
        Map<String, Long> totals = new java.util.LinkedHashMap<>();
        for (String ms : measures) {
            long sum = 0L;
            for (Map<String, Object> m : rows) {
                Object v = m.get(ms);
                if (v instanceof Number n) sum += n.longValue();
            }
            totals.put(ms, sum);
        }
        byte[] body = xlsx.adhoc(new io.reporthub.reportstudio.analytics.AdhocResult(
                t.columns(), rows, totals, t.rowCount()));

        String safe = d.getName() == null ? ("dataset-" + id)
                : d.getName().replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", " ").replaceAll("\\s+", " ").trim();
        org.springframework.http.ContentDisposition cd = org.springframework.http.ContentDisposition
                .attachment().filename(safe + ".xlsx", java.nio.charset.StandardCharsets.UTF_8).build();
        return ResponseEntity.ok()
                .contentType(org.springframework.http.MediaType.parseMediaType(
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                .header(org.springframework.http.HttpHeaders.CONTENT_DISPOSITION, cd.toString())
                .body(body);
    }

    private static void apply(DatasetDef d, SaveDatasetRequest req) {
        d.setName(req.name().trim());
        d.setDescription(req.description());
        d.setFolder(req.folder() == null || req.folder().isBlank() ? null : req.folder().trim());
        d.setDatasourceId(req.datasourceId() == null || req.datasourceId().isBlank() ? null : req.datasourceId());
        d.setSqlText(req.sqlText().trim());
        d.setDimensionColumns(req.dimensionColumns() == null || req.dimensionColumns().isBlank()
                ? null : req.dimensionColumns().trim());
    }

    private static DatasetDto toDto(DatasetDef d) {
        return new DatasetDto(d.getId(), d.getName(), d.getDescription(), d.getFolder(), d.getDatasourceId(),
                d.getSqlText(), d.getCaptureMode(), d.getCapturedAt(), d.getCaptureRows(),
                d.getCreatedBy(), d.getCreatedAt(), d.getDimensionColumns());
    }
}
