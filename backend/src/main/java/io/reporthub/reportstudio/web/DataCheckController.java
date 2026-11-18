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
import io.reporthub.reportstudio.domain.DataCheck;
import io.reporthub.reportstudio.domain.DataCheckRun;
import io.reporthub.reportstudio.service.DataCheckService;
import io.reporthub.reportstudio.service.DatasetService;

import java.time.OffsetDateTime;
import java.util.List;

/** Data checks: CRUD, enable/disable, run, history, and the offending rows behind a failure. */
@RestController
public class DataCheckController {

    public record CheckDto(Long id, String name, String description, String folder,
                           String datasourceId, String sqlText, String fiscalYear, int maxRows,
                           boolean enabled, String cron, OffsetDateTime nextRunAt,
                           OffsetDateTime lastRunAt, String lastStatus, Integer lastCount,
                           String lastError, String createdBy, OffsetDateTime createdAt) {}
    public record RunDto(Long id, Long checkId, OffsetDateTime startedAt, OffsetDateTime finishedAt,
                         String status, String trigger, Integer rowCount, String message, String runBy) {}
    public record SaveRequest(@NotBlank String name, String description, String folder,
                              String datasourceId, @NotBlank String sqlText, String fiscalYear,
                              Integer maxRows, String cron, Boolean enabled) {}
    /** Move-to-group request; null/blank = remove from the group. */
    public record FolderRequest(String folder) {}

    /** Rename-group request. */
    public record RenameFolderRequest(String from, String to) {}

    /** Number of checks moved by a group rename. */
    public record RenamedDto(int moved) {}

    public record ToggleRequest(boolean enabled) {}
    /** Select individually by {@code ids} or a whole group by {@code folder} (blank = ungrouped checks). */
    public record BatchRunRequest(List<Long> ids, String folder) {}

    private final DataCheckService service;
    private final io.reporthub.reportstudio.repo.DataCheckRunRepository runs;
    private final io.reporthub.reportstudio.repo.WarehousePipelineRepository pipelines;

    public DataCheckController(DataCheckService service,
                               io.reporthub.reportstudio.repo.DataCheckRunRepository runs,
                               io.reporthub.reportstudio.repo.WarehousePipelineRepository pipelines,
                               io.reporthub.reportstudio.service.ViewExportService views) {
        this.service = service;
        this.runs = runs;
        this.pipelines = pipelines;
        this.views = views;
    }

    private final io.reporthub.reportstudio.service.ViewExportService views;

    /**
     * Source of a group: which data it checks, which pipeline fills that data, and how fresh it is.
     *
     * <p>The Data Checks view only answers "which rules fail", but a reviewer first asks
     * "where does this data come from and when was it last updated".
     * So the table name is read from the rules' FROM clause and matched to the pipeline that writes it.
     */
    @GetMapping("/checks/group/source")
    public SourceDto groupSource(@RequestParam(required = false) String folder,
                                 @RequestParam(required = false) String year,
                                 @RequestParam(defaultValue = "false") boolean withRows) {
        List<DataCheck> members = service.inFolder(folder);
        String table = DataCheckService.sourceTableOf(members);
        List<String> where = DataCheckService.commonWhere(members);
        String datasourceId = members.stream()
                .map(DataCheck::getDatasourceId).filter(java.util.Objects::nonNull).findFirst().orElse(null);
        // Count rows only when the "Scope" tab asks: it is a count over a table of millions of rows.
        // A user-defined scope always wins over the one inferred from rules, and is what $SCOPE uses at run time.
        var stored = service.scopeOf(folder).orElse(null);
        String fromExpr = null;
        if (stored != null) {
            table = stored.getSource();
            where = DataCheckService.conditionsOf(stored);
            fromExpr = DataCheckService.scopeExpr(stored);
        }
        int usingScope = (int) members.stream()
                .filter(c -> c.getSqlText() != null && c.getSqlText().contains("$SCOPE")).count();
        Long rows = withRows
                ? (fromExpr != null ? service.scopeRows(members, fromExpr, List.of(), year)
                                    : service.scopeRows(members, table, where, year))
                : null;
        if (table == null) {
            return new SourceDto(null, datasourceId, null, null, null, members.size(), where, rows, false, usingScope);
        }
        if (stored != null) {
            // A SELECT source has no table to match against a pipeline, so skip that part.
            String bareTable = table.matches("(?i)[A-Za-z0-9_$#]+(\\.[A-Za-z0-9_$#]+)?") ? table : null;
            if (bareTable == null) {
                return new SourceDto(table, datasourceId, null, null, null, members.size(), where, rows, true, usingScope);
            }
            table = bareTable;
        }

        // A rule may name the table as SCHEMA.TABLE or bare TABLE, so compare both forms.
        final String full0 = table;
        String bare = table.contains(".") ? table.substring(table.indexOf('.') + 1) : table;
        var pipe = pipelines.findAll().stream()
                .filter(w -> {
                    String t = w.getTargetTable();
                    if (t == null) return false;
                    String full = (w.getTargetSchema() == null || w.getTargetSchema().isBlank())
                            ? t : w.getTargetSchema() + "." + t;
                    return full0.equalsIgnoreCase(full) || bare.equalsIgnoreCase(t);
                })
                .findFirst().orElse(null);
        return new SourceDto(table, datasourceId,
                pipe == null ? null : pipe.getName(),
                pipe == null ? null : pipe.getLastRunAt(),
                pipe == null ? null : pipe.getLastRowsWritten(),
                members.size(), where, rows, stored != null, usingScope);
    }

    /**
     * Set or edit a group's scope: the source may be a table name or a full SELECT, plus shared conditions.
     *
     * <p>Rules use it via {@code FROM $SCOPE}, so editing it here once applies to every check that refers to it.
     */
    @PutMapping("/checks/group/scope")
    public SourceDto saveScope(@RequestParam(required = false) String folder,
                               @RequestBody ScopeForm form,
                               java.security.Principal who) {
        String src = form.source() == null ? "" : form.source().trim();
        if (src.isBlank()) throw new BadRequestException("A table name or SELECT is required for the scope");
        // A query source must pass the same guard as SQL elsewhere in the app (SELECT only, single statement).
        if (!src.matches("(?i)[A-Za-z0-9_$#]+(\\.[A-Za-z0-9_$#]+)?")) {
            io.reporthub.reportstudio.service.DatasetService.validateSql(src);
        }
        var sc = service.scopeOf(folder).orElseGet(io.reporthub.reportstudio.domain.CheckGroupScope::new);
        sc.setFolder(folder == null ? "" : folder.trim());
        sc.setSource(src);
        sc.setConditions(form.conditions() == null ? null
                : String.join("\n", form.conditions().stream().map(String::trim).filter(x -> !x.isEmpty()).toList()));
        sc.setUpdatedAt(OffsetDateTime.now());
        sc.setUpdatedBy(who == null ? "anonymous" : who.getName());
        service.saveScope(sc);
        return groupSource(folder, null, true);
    }

    /**
     * Rewrite the SQL of every check in the group to refer to the scope via {@code $SCOPE}.
     *
     * <p>Defaults to a dry run ({@code apply=false}): the UI first shows how many checks would change or be
     * skipped and why, then calls again with apply=true. No guessing: checks that do not match are skipped.
     */
    @PostMapping("/checks/group/scope/adopt")
    public List<io.reporthub.reportstudio.service.ScopeAdopter.Result> adoptScope(
            @RequestParam(required = false) String folder,
            @RequestParam(defaultValue = "false") boolean apply) {
        var sc = service.scopeOf(folder).orElseThrow(
                () -> new BadRequestException("This group has no scope yet; set it in the Scope tab first"));
        String src = sc.getSource() == null ? "" : sc.getSource().trim();
        if (!src.matches("(?i)[A-Za-z0-9_$#]+(\\.[A-Za-z0-9_$#]+)?")) {
            throw new BadRequestException(
                    "The scope source is a SELECT; cannot rewrite automatically because it cannot be matched to the rules' FROM clause");
        }
        var conds = DataCheckService.conditionsOf(sc);
        List<io.reporthub.reportstudio.service.ScopeAdopter.Result> out = new java.util.ArrayList<>();
        for (DataCheck c : service.inFolder(folder)) {
            var r = io.reporthub.reportstudio.service.ScopeAdopter.convert(
                    c.getId(), c.getName(), c.getSqlText(), src, conds);
            out.add(r);
            if (apply && r.changed()) service.replaceSql(c.getId(), r.after());
        }
        return out;
    }

    /** Drop the user-defined scope and go back to inferring it from members' SQL. */
    @DeleteMapping("/checks/group/scope")
    public SourceDto clearScope(@RequestParam(required = false) String folder) {
        service.deleteScope(folder);
        return groupSource(folder, null, true);
    }

    /**
     * History of a group's check "rounds"; one round = running the whole group once.
     *
     * <p>Runs without a batch id (single check runs, scheduled runs, older runs before batch_id existed) are not rounds.
     */
    @GetMapping("/checks/group/rounds")
    public List<RoundDto> groupRounds(@RequestParam(required = false) String folder,
                                      @RequestParam(defaultValue = "20") int limit) {
        List<Long> ids = service.inFolder(folder).stream().map(DataCheck::getId).toList();
        if (ids.isEmpty()) return List.of();
        return runs.summariseRounds(ids, org.springframework.data.domain.PageRequest.of(0, Math.min(Math.max(limit, 1), 100)))
                .stream()
                .map(r -> new RoundDto((String) r[0], (OffsetDateTime) r[1], (OffsetDateTime) r[2],
                        ((Number) r[3]).intValue(), ((Number) r[4]).intValue(), ((Number) r[5]).intValue(),
                        (String) r[6]))
                .toList();
    }

    /** Per-check results of one round, used when viewing past rounds. */
    @GetMapping("/checks/group/rounds/{batchId}")
    public List<RunDto> roundRuns(@PathVariable String batchId) {
        return runs.findByBatchId(batchId).stream().map(DataCheckController::toRunDto).toList();
    }

    /**
     * Per-record results: all failing checks combined and grouped by failing record; a record can fail several checks.
     *
     * <p>The inverse of the rule table: the rule table answers "which checks fail", this answers
     * "what is wrong with this record", which is the view of whoever has to fix the data.
     */
    @GetMapping("/checks/group/findings")
    public List<FindingDto> groupFindings(@RequestParam(required = false) String folder,
                                          @RequestParam(required = false) String key,
                                          @RequestParam(required = false) String year,
                                          @RequestParam(defaultValue = "300") int perRule,
                                          /** Failing records "of this round"; blank = latest result of each check. */
                                          @RequestParam(required = false) String batchId) {
        List<io.reporthub.reportstudio.service.DataCheckService.Finding> out;
        if (batchId != null && !batchId.isBlank()) {
            var members = service.inFolder(folder);
            var names = members.stream().collect(java.util.stream.Collectors.toMap(
                    DataCheck::getId, DataCheck::getName, (a, b) -> a));
            out = service.findingsOfRuns(runs.findByBatchId(batchId.trim()), names, key);
        } else {
            out = service.findings(folder, key, year, perRule);
        }
        return out.stream().map(f -> new FindingDto(f.key(), f.rules(), f.columns())).toList();
    }

    /**
     * Export the table currently shown in the UI as a file; the UI sends the header and rows directly.
     *
     * <p>Done server-side because .xlsx needs a real file writer (the browser can only produce plain text),
     * and so that what is on screen is exactly what is in the file, including active filters.
     */
    @PostMapping("/checks/findings/export")
    public org.springframework.http.ResponseEntity<byte[]> exportFindings(
            @RequestParam(defaultValue = "csv") String format,
            @RequestBody TableForm form) {
        var table = new io.reporthub.reportstudio.service.ViewExportService.Table(
                form.columns() == null ? List.of() : form.columns(),
                form.rows() == null ? List.of() : form.rows().stream()
                        .map(r -> r.stream().map(v -> (Object) v).toList()).toList());
        String fmt = format == null ? "csv" : format.trim().toLowerCase(java.util.Locale.ROOT);
        byte[] body;
        String ext;
        org.springframework.http.MediaType mime;
        switch (fmt) {
            case "xlsx" -> {
                body = views.toXlsx(table);
                ext = ".xlsx";
                mime = org.springframework.http.MediaType.parseMediaType(
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            }
            case "txt" -> {
                // Tab-separated plain text: opens anywhere and pastes straight into Excel.
                StringBuilder sb = new StringBuilder("\uFEFF");
                sb.append(String.join("\t", table.columns())).append("\r\n");
                for (var r : table.rows()) {
                    sb.append(r.stream().map(v -> v == null ? "" : String.valueOf(v).replaceAll("[\\t\\r\\n]", " "))
                            .collect(java.util.stream.Collectors.joining("\t"))).append("\r\n");
                }
                body = sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                ext = ".txt";
                mime = org.springframework.http.MediaType.parseMediaType("text/plain; charset=UTF-8");
            }
            case "csv" -> {
                body = views.toCsv(table);
                ext = ".csv";
                mime = org.springframework.http.MediaType.parseMediaType("text/csv; charset=UTF-8");
            }
            default -> throw new BadRequestException("Unknown export format: " + format);
        }
        String name = (form.filename() == null || form.filename().isBlank() ? "findings" : form.filename())
                .replaceAll("[\\\\/:*?\"<>|]+", "_") + ext;
        return org.springframework.http.ResponseEntity.ok()
                .contentType(mime).contentLength(body.length)
                .header(org.springframework.http.HttpHeaders.CONTENT_DISPOSITION,
                        org.springframework.http.ContentDisposition.attachment().filename(name).build().toString())
                .body(body);
    }

    /** Table sent by the UI to be written as a file. */
    public record TableForm(List<String> columns, List<List<String>> rows, String filename) {}

    /** One record that fails rules, with the names of the failing checks. */
    public record FindingDto(String key, List<String> rules, java.util.Map<String, Object> columns) {}

    /** Source of a group: the table the rules read, the pipeline filling it, and data freshness. */
    /**
     * @param where     conditions shared by every check in the group = the scope of the checked data
     * @param scopeRows row count in that scope; null = not requested or could not be counted
     */
    public record SourceDto(String table, String datasourceId, String pipelineName,
                            OffsetDateTime pipelineLastRunAt, Integer pipelineRows, int rules,
                            List<String> where, Long scopeRows,
                            /** true = user-defined scope (editable); false = inferred live from members' SQL */
                            boolean stored,
                            /** Number of rules in the group referring to the scope via $SCOPE, i.e. how many an edit really affects */
                            int usingScope) {}

    /** Payload sent by the UI when saving a group scope. */
    public record ScopeForm(String source, List<String> conditions) {}

    /** One check round of a group. */
    public record RoundDto(String batchId, OffsetDateTime startedAt, OffsetDateTime finishedAt,
                           int total, int passed, int failed, String runBy) {}

    @GetMapping("/checks")
    public List<CheckDto> list() {
        return service.list().stream().map(DataCheckController::toDto).toList();
    }

    @GetMapping("/checks/{id}")
    public CheckDto get(@PathVariable Long id) {
        return toDto(service.require(id));
    }

    @PostMapping("/checks")
    @ResponseStatus(HttpStatus.CREATED)
    public CheckDto create(@Valid @RequestBody SaveRequest req, Authentication auth) {
        return toDto(service.save(null, fromReq(req), auth == null ? "system" : auth.getName()));
    }

    @PutMapping("/checks/{id}")
    public CheckDto update(@PathVariable Long id, @Valid @RequestBody SaveRequest req) {
        return toDto(service.save(id, fromReq(req), null));
    }

    /** Move checks into/out of a group; only the group name is sent, not the whole check. */
    @PostMapping("/checks/{id}/folder")
    public CheckDto setFolder(@PathVariable Long id, @RequestBody FolderRequest req) {
        return toDto(service.setFolder(id, req.folder()));
    }

    /** Rename a whole group; every check in the old group moves with it. */
    @PostMapping("/checks/folder/rename")
    public RenamedDto renameFolder(@RequestBody RenameFolderRequest req) {
        return new RenamedDto(service.renameFolder(req.from(), req.to()));
    }

    @PostMapping("/checks/{id}/toggle")
    public CheckDto toggle(@PathVariable Long id, @RequestBody ToggleRequest req) {
        return toDto(service.setEnabled(id, req.enabled()));
    }

    /** @param year the fiscal year the portal is set to; falls back to the check's own. */
    @PostMapping("/checks/{id}/run")
    public RunDto run(@PathVariable Long id,
                      @RequestParam(required = false) String year,
                      Authentication auth) {
        return toRunDto(service.runNow(id, auth == null ? "system" : auth.getName(), year));
    }

    /**
     * Run several checks in one request; returns as soon as all are queued, without waiting for results.
     *
     * <p>Must not wait for results: the slowest check takes ~96 s and 20 checks ~260 s, while the edge
     * gateway cuts requests slower than ~30 s with a 502 HTML page.
     */
    @PostMapping("/checks/run")
    public List<RunDto> runBatch(@RequestBody BatchRunRequest req,
                                 @RequestParam(required = false) String year,
                                 Authentication auth) {
        return service.runBatch(req.ids(), req.folder(), auth == null ? "system" : auth.getName(), year)
                .stream().map(DataCheckController::toRunDto).toList();
    }

    @GetMapping("/checks/{id}/runs")
    public List<RunDto> runs(@PathVariable Long id, @RequestParam(defaultValue = "30") int limit) {
        return service.history(id, limit).stream().map(DataCheckController::toRunDto).toList();
    }

    /** The rows that made it fail — re-run on demand, never stored. */
    @GetMapping("/checks/{id}/rows")
    public DatasetService.TableResult rows(@PathVariable Long id,
                                           @RequestParam(required = false) String year,
                                           @RequestParam(defaultValue = "100") int limit) {
        return service.offendingRows(id, year, limit);
    }

    @DeleteMapping("/checks/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        service.delete(id);
    }

    private static DataCheck fromReq(SaveRequest req) {
        DataCheck c = new DataCheck();
        c.setName(req.name());
        c.setDescription(req.description());
        c.setFolder(req.folder());
        c.setDatasourceId(req.datasourceId());
        c.setSqlText(req.sqlText());
        c.setFiscalYear(req.fiscalYear());
        c.setMaxRows(req.maxRows() == null ? 0 : req.maxRows());
        c.setCron(req.cron());
        c.setEnabled(req.enabled() == null || req.enabled());
        return c;
    }

    private static CheckDto toDto(DataCheck c) {
        return new CheckDto(c.getId(), c.getName(), c.getDescription(), c.getFolder(),
                c.getDatasourceId(), c.getSqlText(), c.getFiscalYear(), c.getMaxRows(),
                c.isEnabled(), c.getCron(), c.getNextRunAt(), c.getLastRunAt(),
                c.getLastStatus(), c.getLastCount(), c.getLastError(), c.getCreatedBy(), c.getCreatedAt());
    }

    private static RunDto toRunDto(DataCheckRun r) {
        return new RunDto(r.getId(), r.getCheckId(), r.getStartedAt(), r.getFinishedAt(),
                r.getStatus(), r.getTrigger(), r.getRowCount(), r.getMessage(), r.getRunBy());
    }
}
