package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.repo.RepoTableRepository;
import io.reporthub.reportstudio.service.RepositoryService;

import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Database Tool / "Repository": browse and edit the tables of any configured
 * datasource. Reads need a signed-in user; writes flow through parameterized, identifier-validated
 * statements (see {@link RepositoryService}). The SQL Editor is keyword-guarded (no DDL).
 */
@RestController
public class RepositoryController {

    public record RowWrite(String datasourceId, String schema, Map<String, Object> values) {}
    public record RowUpdate(String datasourceId, String schema, Map<String, Object> set, Map<String, Object> key) {}
    public record RowKey(String datasourceId, String schema, Map<String, Object> key) {}
    /** source = screen the run came from (adhoc · tables), stored in history — optional; old callers still work */
    public record ExecRequest(String datasourceId, @NotBlank String sql, String source,
                             /** Column header filters open on the screen (column name → ticked values/search text).
                              *  Used only for export, so the file matches what the user sees. */
                             java.util.Map<String, ColFilter> filters,
                             /** Values for $NAME / :name variables in the statement (bound, never spliced). */
                             java.util.Map<String, String> params,
                             /** Same as params (name the frontend sends); both are merged. */
                             java.util.Map<String, String> variables) {
        /** Values for $NAME / :name variables: {@code variables} overlaid on {@code params}. */
        public java.util.Map<String, String> values() {
            java.util.Map<String, String> m = new java.util.LinkedHashMap<>();
            if (params != null) m.putAll(params);
            if (variables != null) m.putAll(variables);
            return m;
        }
    }

    /** Filter for one column — ticked values and/or search text (both = must match both). */
    public record ColFilter(java.util.List<String> values, String contains) {}

    private final RepositoryService service;
    private final RepoTableRepository registry;
    private final io.reporthub.reportstudio.service.ViewExportService views;
    private final io.reporthub.reportstudio.repo.SqlRunLogRepository sqlLog;

    private final io.reporthub.reportstudio.gateway.JobGateway jobs;
    private final io.reporthub.reportstudio.service.QueryQueueService queue;

    public RepositoryController(RepositoryService service, RepoTableRepository registry,
                                io.reporthub.reportstudio.service.ViewExportService views,
                                io.reporthub.reportstudio.repo.SqlRunLogRepository sqlLog,
                                io.reporthub.reportstudio.gateway.JobGateway jobs,
                                io.reporthub.reportstudio.service.QueryQueueService queue) {
        this.service = service;
        this.registry = registry;
        this.views = views;
        this.sqlLog = sqlLog;
        this.jobs = jobs;
        this.queue = queue;
    }

    /** A write this controller can be asked to make. */
    private enum Op { INSERT, UPDATE, DELETE }

    /**
     * What each host-app menu allows to be written to the rows it shows.
     *
     * <p>The read-only menu allows no writes, and the update-only menu can only update existing rows (no
     * insert/delete). The repository
     * screen draws the same policy (MENU_RIGHTS in repository/page.tsx); this is what makes it true
     * rather than merely invisible, since the endpoints are reachable without the screen.
     *
     * <p>A menu absent from this map allows everything, which is what /repository is on its own.
     */
    private static final Map<String, java.util.Set<Op>> MENU_RIGHTS = Map.of(
            "read-only", java.util.Set.of(),
            "update-only", java.util.Set.of(Op.UPDATE));

    /**
     * A write is only allowed on a table that has been put on a screen, and only if some screen
     * showing it allows that write.
     *
     * <p>Without the first half, any signed-in user could update ANY table through this endpoint:
     * the write rules leave /repository/** at authenticated(), and the datasource connects as a DB
     * account with database-wide rights, so the reach was the whole schema rather than the four
     * tables the screens offer. Without it, a plain ROLE_USER could update an arbitrary table.
     *
     * <p>The second half is per-menu, not per-table, because one table can sit on two menus —
     * the same table can appear on one screen twice. A write is refused only when EVERY screen carrying the
     * table forbids it; a table reachable from an editable screen stays editable.
     *
     * <p>ADMIN is exempt — the raw catalogue browse and the SQL editor are theirs by design.
     */
    private void assertWritable(Authentication auth, String datasourceId, String schema, String table, Op op) {
        boolean admin = auth != null && auth.getAuthorities().stream()
                .anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
        if (admin) return;
        List<io.reporthub.reportstudio.domain.RepoTable> on = registry.findByActiveTrueOrderBySortOrderAscIdAsc().stream()
                .filter(e -> e.getTableName().equalsIgnoreCase(table)
                        && java.util.Objects.equals(
                                e.getDatasourceId() == null ? null : e.getDatasourceId().toLowerCase(),
                                datasourceId == null ? null : datasourceId.toLowerCase())
                        && (e.getSchemaName() == null || e.getSchemaName().equalsIgnoreCase(schema)))
                .toList();
        if (on.isEmpty()) {
            throw new BadRequestException("This table is not on a data screen, so it cannot be edited here: " + table);
        }
        boolean allowed = on.stream().anyMatch(e ->
                MENU_RIGHTS.getOrDefault(e.getMenuKey() == null ? "" : e.getMenuKey(),
                        java.util.EnumSet.allOf(Op.class)).contains(op));
        if (!allowed) {
            throw new BadRequestException("The screen showing this table does not allow "
                    + switch (op) { case INSERT -> "adding rows"; case UPDATE -> "editing data"; case DELETE -> "deleting rows"; }
                    + ": " + table);
        }
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    io.reporthub.reportstudio.acl.AclService acl;

    /**
     * Read gate for an {@code optionsFrom} lookup ({@code SCHEMA.TABLE.CODE.NAME[@...]}): a non-admin may
     * only use a spec configured on a registry entry of the data table (its filter columns), or a lookup
     * table that is itself registered for the datasource - with the same datasource ACL. Row filters of the
     * lookup table are applied by the service.
     */
    void assertOptionsFromReadable(String datasourceId, String schema, String table, String optionsFrom) {
        if (callerIsAdmin() || optionsFrom == null || optionsFrom.isBlank()) return;
        String spec = optionsFrom.trim();
        String[] p = spec.split("@", 2)[0].trim().split("\\.");
        if (p.length != 4) throw new BadRequestException("Options source must be SCHEMA.TABLE.CODE.NAME: " + spec);
        io.reporthub.reportstudio.service.AppDatabaseGuard.checkSchema(p[0]);
        boolean configured = registry.findForPhysicalTable(schema == null || schema.isBlank() ? null : schema, table).stream()
                .filter(e -> e.isActive() && datasourceId != null && datasourceId.equalsIgnoreCase(e.getDatasourceId()))
                .anyMatch(e -> configuredOptionsFrom(e.getFilterColumns()).stream().anyMatch(spec::equalsIgnoreCase));
        if (!configured) assertReadable(datasourceId, p[0], p[1]);
    }

    /** optionsFrom specs of a registry entry's filter columns ({@code col:label:labelSource:optionsFrom:default}). */
    static java.util.List<String> configuredOptionsFrom(String filterColumns) {
        if (filterColumns == null || filterColumns.isBlank()) return java.util.List.of();
        java.util.List<String> out = new java.util.ArrayList<>();
        for (String entry : filterColumns.split(",")) {
            String[] f = entry.split(":");
            if (f.length >= 4 && !f[3].isBlank()) out.add(f[3].trim());
        }
        return out;
    }

    /** Admins may browse any table; everyone else only tables registered on a data screen. */
    static boolean callerIsAdmin() {
        return io.reporthub.reportstudio.iam.CurrentPrincipal.get().map(p -> p.admin()).orElse(false);
    }

    /**
     * Read gate for generic table endpoints (rows / meta / export / distinct): a non-admin must name a
     * registered datasource (never the application's own database) and a table that is registered in
     * the repository registry for that datasource. ACL and row filters are then applied by the service.
     */
    void assertReadable(String datasourceId, String schema, String table) {
        if (callerIsAdmin()) return;
        if (datasourceId == null || datasourceId.isBlank()) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.FORBIDDEN, "datasourceId is required");
        }
        io.reporthub.reportstudio.service.AppDatabaseGuard.checkSchema(schema);
        if (acl != null && !acl.allowed("DATASOURCE", datasourceId, "view")) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.FORBIDDEN, "No view access to datasource " + datasourceId);
        }
        boolean registered = registry.findForPhysicalTable(schema == null || schema.isBlank() ? null : schema, table)
                .stream().anyMatch(e -> e.isActive() && datasourceId.equalsIgnoreCase(e.getDatasourceId()));
        if (!registered) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.FORBIDDEN, "Table is not available: " + table);
        }
    }

    @GetMapping("/repository/tables")
    public List<RepositoryService.TableInfo> tables(@RequestParam(required = false) String datasourceId) {
        if (!callerIsAdmin()) {
            if (datasourceId == null || datasourceId.isBlank()) return List.of();
            java.util.Set<String> mine = registry.findByActiveTrueOrderBySortOrderAscIdAsc().stream()
                    .filter(e -> datasourceId.equalsIgnoreCase(e.getDatasourceId()))
                    .map(e -> e.getTableName().toUpperCase(java.util.Locale.ROOT))
                    .collect(java.util.stream.Collectors.toSet());
            return service.tables(datasourceId).stream()
                    .filter(t -> mine.contains(t.name().toUpperCase(java.util.Locale.ROOT))).toList();
        }
        return service.tables(datasourceId);
    }

    @GetMapping("/repository/tables/{table}/meta")
    public RepositoryService.TableMeta meta(@PathVariable String table,
                                            @RequestParam(required = false) String datasourceId,
                                            @RequestParam(required = false) String schema) {
        assertReadable(datasourceId, schema, table);
        return service.meta(datasourceId, schema, table);
    }

    /**
     * @param eq repeatable {@code COLUMN=value} restriction, e.g.
     *           {@code ?eq=STATUS=active&eq=PARENT_ID=df25...}. Kept as a separate repeatable
     *           param rather than free-form SQL so the column can be checked against the live
     *           catalog and the value bound.
     */
    @GetMapping("/repository/tables/{table}/rows")
    public RepositoryService.Rows rows(@PathVariable String table,
                                       @RequestParam(required = false) String datasourceId,
                                       @RequestParam(required = false) String schema,
                                       @RequestParam(defaultValue = "100") int limit,
                                       @RequestParam(defaultValue = "0") int offset,
                                       @RequestParam(name = "eq", required = false) List<String> eq,
                                       @RequestParam(defaultValue = "false") boolean withTotal,
                                       @RequestParam(defaultValue = "false") boolean withRowId,
                                       @RequestParam(name = "filters", required = false) String filters,
                                       @RequestParam(name = "sort", required = false) String sort) {
        assertReadable(datasourceId, schema, table);
        return service.rows(datasourceId, schema, table, limit, offset, parseEq(eq), withTotal, withRowId,
                            parseFilters(filters), sort);
    }

    /**
     * The whole filtered table as one downloadable file — {@code format} is {@code txt} (pipe-
     * delimited, the external-system submission shape), {@code csv} or {@code xlsx}. Same {@code eq}
     * contract as {@code /rows} including the {@code ';'} packing.
     *
     * <p>The file is fully generated into a temp file BEFORE any response byte goes out, then
     * streamed and deleted. Order matters: the row-cap refusal and any SQL failure must arrive as
     * a clean 400 the toast can show — an error thrown after headers are committed would truncate
     * the download silently, and a truncated export file looks exactly like a complete one.
     * Deliberately a GET: some WAFs inspect POST bodies (and blocks other verbs), while
     * this query-param shape is the one /rows has already proven passes it.
     */
    /**
     * Queues an export of this table on the real export system and returns the job id immediately.
     *
     * <p>Unlike {@code /export}, which runs on the request thread: the whole file must be written before the
     * first byte is sent, so a very large table hangs for many minutes, a reverse proxy may cut it off, and the
     * database query keeps running (the same mechanism that once exhausted the database). The {@code sql}
     * engine streams row by row to the file, handles million-row results, can be cancelled mid-way, shows
     * progress and keeps the file for later download.
     *
     * @param year 4-digit year chosen by the caller; needs {@code yearColumn}
     * @param yearColumn the table's configured year column (registry {@code repo_table.year_column})
     */
    @PostMapping("/repository/tables/{table}/export-job")
    public java.util.Map<String, String> exportJob(@PathVariable String table,
                                                   @RequestParam(required = false) String datasourceId,
                                                   @RequestParam(required = false) String schema,
                                                   @RequestParam(defaultValue = "csv") String format,
                                                   @RequestParam(required = false) String year,
                                                   @RequestParam(required = false) String yearColumn,
                                                   @RequestParam(name = "eq", required = false) List<String> eq,
                                                   @RequestParam(name = "columns", required = false) List<String> columns,
                                                   @RequestParam(name = "filters", required = false) String filters,
                                                   @RequestParam(name = "labels", required = false) String labels,
                                                   @RequestParam(name = "sort", required = false) String sort,
                                                   @RequestParam(name = "label", required = false) String label,
                                                   Authentication auth) {
        assertReadable(datasourceId, schema, table);
        String fmt = switch (format == null ? "" : format.trim().toLowerCase()) {
            case "txt", "csv", "xlsx" -> format.trim().toLowerCase();
            default -> throw new BadRequestException("File format must be txt / csv / xlsx: " + format);
        };
        // columns = the column order the screen is showing; the file follows it (absent = whole table in real order)
        RepositoryService.ExportSql x = service.exportSql(datasourceId, schema, table, parseEq(eq),
                                                          parseFilters(filters), year, columns, parseEq(
                                                              labels == null ? null : List.of(labels)), sort, yearColumn);
        String who = auth == null ? "console" : auth.getName();
        // Synthetic reportCode: there is no Report row in the registry — the worker already supports that
        // (no unit ⇒ single-engine path using the sqlStatement passed directly)
        String code = "TBL-" + x.table();
        String display = label != null && !label.isBlank() ? label.trim()
                : (x.schema() == null || x.schema().isBlank() ? x.table() : x.schema() + "." + x.table());
        String jobId = jobs.submit(code, "Export " + display,
                "sql", fmt, new java.util.LinkedHashMap<>(x.params()), x.sql(),
                datasourceId, who, "normal", null);
        return java.util.Map.of("jobId", jobId, "sql", x.sql());
    }

    @GetMapping("/repository/tables/{table}/export")
    public org.springframework.http.ResponseEntity<org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody>
    export(@PathVariable String table,
           @RequestParam(required = false) String datasourceId,
           @RequestParam(required = false) String schema,
           @RequestParam(defaultValue = "csv") String format,
           @RequestParam(name = "eq", required = false) List<String> eq,
           @RequestParam(name = "filters", required = false) String filters,
           @RequestParam(name = "sort", required = false) String sort) throws java.io.IOException {
        assertReadable(datasourceId, schema, table);
        String ext = switch (format) {
            case "txt" -> ".txt"; case "csv" -> ".csv"; case "xlsx" -> ".xlsx";
            default -> throw new BadRequestException("Unknown export format: " + format);
        };
        java.nio.file.Path tmp = java.nio.file.Files.createTempFile("repo-export-", ext);
        try {
            try (var out = java.nio.file.Files.newOutputStream(tmp)) {
                service.export(datasourceId, schema, table, parseEq(eq), parseFilters(filters), sort, format, out);
            }
        } catch (Exception e) {
            java.nio.file.Files.deleteIfExists(tmp);
            throw e;
        }
        String filename = table + "_" + java.time.LocalDateTime.now()
                .format(java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd-HHmm")) + ext;
        var mime = switch (format) {
            case "xlsx" -> org.springframework.http.MediaType.parseMediaType(
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            case "txt" -> org.springframework.http.MediaType.parseMediaType("text/plain; charset=UTF-8");
            default -> org.springframework.http.MediaType.parseMediaType("text/csv; charset=UTF-8");
        };
        org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody body = out -> {
            try {
                java.nio.file.Files.copy(tmp, out);
            } finally {
                java.nio.file.Files.deleteIfExists(tmp);
            }
        };
        return org.springframework.http.ResponseEntity.ok()
                .contentType(mime)
                .contentLength(java.nio.file.Files.size(tmp))
                .header(org.springframework.http.HttpHeaders.CONTENT_DISPOSITION,
                        org.springframework.http.ContentDisposition.attachment().filename(filename).build().toString())
                .body(body);
    }

    /**
     * Values to offer in a filter picker for one column, each with the name to show beside it.
     *
     * @param labelSource where the name comes from — a column of this table, or
     *                    {@code SCHEMA.TABLE.CODE.NAME} for a lookup. Omit for code-only.
     */
    /**
     * Column header "funnel" filters — sent as a single JSON blob in a parameter named {@code filters}.
     *
     * <p>It must be one parameter: the edge in front of the app returns 403 for requests that repeat a
     * parameter name (the same reason {@code eq} is packed with ';' rather than repeated), and the
     * {@code eq} syntax cannot be extended because search text may itself contain ';' or '='.
     *
     * <p>Shape: {@code [{"column":"REGION","values":["01000"],"contains":"north"}]}
     */
    private static List<RepositoryService.ColFilter> parseFilters(String json) {
        if (json == null || json.isBlank()) return List.of();
        try {
            com.fasterxml.jackson.databind.ObjectMapper om = new com.fasterxml.jackson.databind.ObjectMapper();
            List<java.util.Map<String, Object>> raw = om.readValue(json, new
                    com.fasterxml.jackson.core.type.TypeReference<List<java.util.Map<String, Object>>>() {});
            List<RepositoryService.ColFilter> out = new java.util.ArrayList<>();
            for (java.util.Map<String, Object> r : raw) {
                Object col = r.get("column");
                if (col == null || col.toString().isBlank()) continue;
                List<String> vals = new java.util.ArrayList<>();
                Object v = r.get("values");
                if (v instanceof List<?> list) for (Object o : list) if (o != null) vals.add(String.valueOf(o));
                Object q = r.get("contains");
                out.add(new RepositoryService.ColFilter(col.toString(), vals, q == null ? null : String.valueOf(q)));
            }
            return out;
        } catch (Exception e) {
            throw new BadRequestException("Could not parse column filters: " + e.getMessage());
        }
    }

    @GetMapping("/repository/tables/{table}/distinct")
    public List<RepositoryService.Option> distinct(@PathVariable String table,
                                                   @RequestParam String column,
                                                   @RequestParam(required = false) String labelSource,
                                                   @RequestParam(required = false) String datasourceId,
                                                   @RequestParam(required = false) String schema,
                                                   @RequestParam(required = false) String q,
                                                   @RequestParam(defaultValue = "200") int limit,
                                                   @RequestParam(name = "eq", required = false) List<String> eq,
                                                   @RequestParam(required = false) String optionsFrom,
                                                   @RequestParam(name = "filters", required = false) String filters) {
        // optionsFrom = a small lookup table holding the possible values of this column ({@code SCHEMA.TABLE.CODE.NAME}).
        // When set, options are read from there instead of scanning the data table — measured: large tables
        // cannot feed a dropdown whatever the conditions. eq is still passed to scope the legacy path.
        assertReadable(datasourceId, schema, table);
        assertOptionsFromReadable(datasourceId, schema, table, optionsFrom);
        return service.distinct(datasourceId, schema, table, column, labelSource, q, limit,
                                parseEq(eq), optionsFrom, parseFilters(filters));
    }

    /**
     * {@code COLUMN=value} pairs; split on the FIRST '=' so a value may contain one.
     *
     * <p>A single {@code eq} may also carry several pairs separated by {@code ';'}
     * ({@code eq=REGION=01000;BRANCH=01007}). That is not cosmetic: the CDN in front of the app
     * 403s any request that repeats a query-parameter name, so two filters sent
     * as two {@code eq} params never reach the app (one passes, two are blocked
     * regardless of content). Packing them into one param is what makes multi-column filtering
     * possible at all. Repeated params still work for clients that are not behind that edge.
     */
    private static Map<String, String> parseEq(List<String> eq) {
        if (eq == null || eq.isEmpty()) return Map.of();
        Map<String, String> out = new LinkedHashMap<>();
        for (String param : eq) {
            if (param == null) continue;
            for (String pair : param.split(";")) {
                if (pair.isBlank()) continue;
                int at = pair.indexOf('=');
                if (at <= 0) throw new BadRequestException("Expected COLUMN=value, got: " + pair);
                out.put(pair.substring(0, at).trim(), pair.substring(at + 1));
            }
        }
        return out;
    }

    @PostMapping("/repository/tables/{table}/rows")
    public Map<String, Integer> insert(@PathVariable String table, @RequestBody RowWrite req, Authentication auth) {
        assertWritable(auth, req.datasourceId(), req.schema(), table, Op.INSERT);
        return rowWrite(req.datasourceId(), auth, "insert", where(req.schema(), table), req.values(), null,
                () -> service.insert(req.datasourceId(), req.schema(), table, req.values()));
    }

    @PostMapping("/repository/tables/{table}/rows/update")
    public Map<String, Integer> update(@PathVariable String table, @RequestBody RowUpdate req, Authentication auth) {
        assertWritable(auth, req.datasourceId(), req.schema(), table, Op.UPDATE);
        return rowWrite(req.datasourceId(), auth, "update", where(req.schema(), table), req.set(), req.key(),
                () -> service.update(req.datasourceId(), req.schema(), table, req.set(), req.key()));
    }

    @PostMapping("/repository/tables/{table}/rows/delete")
    public Map<String, Integer> delete(@PathVariable String table, @RequestBody RowKey req, Authentication auth) {
        assertWritable(auth, req.datasourceId(), req.schema(), table, Op.DELETE);
        return rowWrite(req.datasourceId(), auth, "delete", where(req.schema(), table), null, req.key(),
                () -> service.deleteRow(req.datasourceId(), req.schema(), table, req.key()));
    }

    private static String where(String schema, String table) {
        return (schema == null || schema.isBlank() ? "" : schema + ".") + table;
    }

    /**
     * Writes a row from the on-screen table and always leaves an audit trail, like the free-form SQL box.
     *
     * <p>Previously these three paths wrote no history at all, while {@code /repository/execute} logs every
     * run — so edits made through the screen were never recorded and "who changed this row" could not be
     * answered. That asymmetry is more dangerous than the SQL side, since the screen is far easier to use.
     *
     * <p>There is no guard against non-unique keys — {@code UPDATE ... WHERE key = ?}: if the key columns
     * configured in the registry (repo_table.key_columns) are not actually unique, a single-row edit on the
     * screen silently hits several rows. It is not blocked yet (that would change behaviour others rely on),
     * but the affected row count is always logged and the screen warns when it is not 1.
     */
    private Map<String, Integer> rowWrite(String datasourceId, Authentication auth, String kind, String target,
                                          Map<String, Object> values, Map<String, Object> key,
                                          java.util.function.IntSupplier action) {
        long t0 = System.nanoTime();
        String sketch = kind.toUpperCase() + " " + target
                + (values == null || values.isEmpty() ? "" : " SET " + String.join(", ", values.keySet()))
                + (key == null || key.isEmpty() ? "" : " WHERE " + String.join(" AND ",
                        key.entrySet().stream().map((e) -> e.getKey() + " = " + e.getValue()).toList()));
        try {
            int affected = action.getAsInt();
            writeRowLog(datasourceId, auth, kind, sketch, affected, ms(t0), "ok", null);
            return Map.of("affected", affected);
        } catch (RuntimeException e) {
            writeRowLog(datasourceId, auth, kind, sketch, null, ms(t0), "error", e.getMessage());
            throw e;
        }
    }

    private void writeRowLog(String datasourceId, Authentication auth, String kind, String sketch,
                             Integer affected, int ms, String status, String error) {
        try {
            var log = new io.reporthub.reportstudio.domain.SqlRunLog();
            log.setDatasourceId(datasourceId);
            log.setStatementKind(kind);
            log.setSqlText(sketch);
            log.setRowCount(null);
            log.setAffected(affected);
            log.setDurationMs(ms);
            log.setStatus(status);
            log.setErrorText(error == null ? null : error.length() > 4000 ? error.substring(0, 4000) : error);
            // Separate source from the SQL box's "tables" so edits made via the on-screen grid can be filtered
            log.setSource("grid");
            log.setCreatedBy(auth == null ? "anonymous" : auth.getName());
            log.setCreatedAt(java.time.OffsetDateTime.now());
            sqlLog.save(log);
        } catch (Exception ignored) {
            // best-effort like the SQL side — failing to write the log must not turn a successful write into an error
        }
    }

    /**
     * Runs one statement from the free-form SQL box and always leaves an audit trail.
     *
     * <p>The box really runs INSERT/UPDATE/DELETE/MERGE and PL/SQL blocks, so every run is logged — successes
     * and failures (the failures are the ones read most). Logging is best-effort like ad-hoc history: if the
     * log cannot be written, a successful statement must not become an error.
     */
    @PostMapping("/repository/execute")
    public Map<String, String> execute(@Valid @RequestBody ExecRequest req, Authentication auth) {
        // Classify the statement at submit time — invalid SQL must be rejected as soon as it is sent,
        // not discovered when polling for status later
        RepositoryService.classify(req.sql());
        try {
            io.reporthub.reportstudio.util.SqlVariables.bind(req.sql(), req.values());   // 400 now, not at poll time
        } catch (IllegalArgumentException e) {
            throw new BadRequestException(e.getMessage());
        }
        String id = queue.submit(() -> {
            long t0 = System.nanoTime();
            try {
                RepositoryService.ExecResult res = service.execute(req.datasourceId(), req.sql(), req.values());
                writeLog(req, auth, res.kind(),
                        "select".equals(res.kind()) ? res.rowCount() : null,
                        "select".equals(res.kind()) ? null : res.affected(),
                        ms(t0), "ok", null);
                return res;
            } catch (RuntimeException e) {
                // kind can still be decided when the statement fails — kept so history can be filtered to writes
                String kind;
                try { kind = RepositoryService.classify(req.sql()); } catch (RuntimeException ignored) { kind = "unknown"; }
                writeLog(req, auth, kind, null, null, ms(t0), "error", e.getMessage());
                throw e;
            }
        });
        return Map.of("id", id, "status", "running");
    }

    /** Result of a queued statement — the screen polls until status is no longer running. */
    @GetMapping("/repository/execute/result/{id}")
    public io.reporthub.reportstudio.service.QueryQueueService.Job executeResult(@PathVariable String id) {
        return queue.get(id);
    }

    /** Recent SQL run history — {@code mine=true} shows only the caller's own. */
    @GetMapping("/repository/execute/history")
    public List<Map<String, Object>> executeHistory(@RequestParam(defaultValue = "30") int limit,
                                                    @RequestParam(defaultValue = "false") boolean mine,
                                                    Authentication auth) {
        var page = org.springframework.data.domain.PageRequest.of(0, Math.min(Math.max(limit, 1), 200));
        var rows = mine && auth != null
                ? sqlLog.findByCreatedByOrderByCreatedAtDesc(auth.getName(), page)
                : sqlLog.findAllByOrderByCreatedAtDesc(page);
        return rows.stream().map(r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.getId());
            m.put("datasourceId", r.getDatasourceId());
            m.put("kind", r.getStatementKind());
            m.put("sql", r.getSqlText());
            m.put("rowCount", r.getRowCount());
            m.put("affected", r.getAffected());
            m.put("ms", r.getDurationMs());
            m.put("status", r.getStatus());
            m.put("error", r.getErrorText());
            m.put("source", r.getSource());
            m.put("createdBy", r.getCreatedBy());
            m.put("createdAt", r.getCreatedAt());
            return m;
        }).toList();
    }

    private static int ms(long t0) {
        return (int) ((System.nanoTime() - t0) / 1_000_000L);
    }

    private void writeLog(ExecRequest req, Authentication auth, String kind,
                          Integer rowCount, Integer affected, int ms, String status, String error) {
        try {
            var log = new io.reporthub.reportstudio.domain.SqlRunLog();
            log.setDatasourceId(req.datasourceId());
            log.setStatementKind(kind == null ? "unknown" : kind);
            // Statements hundreds of thousands of characters long (generated scripts) do not help tracing
            // and bloat the history table — the first 20,000 characters are enough
            String sql = req.sql() == null ? "" : req.sql();
            log.setSqlText(sql.length() > 20_000 ? sql.substring(0, 20_000) + "\n-- …truncated at 20,000 characters" : sql);
            log.setRowCount(rowCount);
            log.setAffected(affected);
            log.setDurationMs(ms);
            log.setStatus(status);
            log.setErrorText(error == null ? null : error.length() > 4000 ? error.substring(0, 4000) : error);
            log.setSource(req.source());
            log.setCreatedBy(auth == null ? "anonymous" : auth.getName());
            log.setCreatedAt(java.time.OffsetDateTime.now());
            sqlLog.save(log);
        } catch (Exception ignored) {
            // History is best-effort — a statement that already ran must not become an error because logging failed
        }
    }

    /**
     * Filters rows with the same rules as the on-screen column filters — plain text comparison, NULL counts as empty.
     *
     * <p>Done at this layer rather than appended to the SQL as a WHERE for one reason: the result must match
     * the screen exactly. In SQL the database compares by real data type (numbers, dates, trailing spaces),
     * which gives different answers from the screen's text comparison ⇒ a file that differs from what is seen,
     * which is exactly the problem being fixed.
     */
    private io.reporthub.reportstudio.service.ViewExportService.Table applyFilters(
            io.reporthub.reportstudio.service.ViewExportService.Table t,
            java.util.Map<String, ColFilter> filters) {
        if (filters == null || filters.isEmpty()) return t;
        record Active(int col, java.util.Set<String> values, String contains) {}
        java.util.List<Active> active = new java.util.ArrayList<>();
        for (var e : filters.entrySet()) {
            int j = t.columns().indexOf(e.getKey());
            if (j < 0 || e.getValue() == null) continue;          // column missing from this result = nothing to filter
            var vals = e.getValue().values() == null ? java.util.List.<String>of() : e.getValue().values();
            String contains = e.getValue().contains() == null ? "" : e.getValue().contains().trim();
            if (vals.isEmpty() && contains.isEmpty()) continue;
            active.add(new Active(j, new java.util.HashSet<>(vals), contains.toLowerCase(java.util.Locale.ROOT)));
        }
        if (active.isEmpty()) return t;
        java.util.List<java.util.List<Object>> kept = new java.util.ArrayList<>();
        for (var r : t.rows()) {
            boolean ok = true;
            for (var a : active) {
                Object v = a.col() < r.size() ? r.get(a.col()) : null;
                String cell = v == null ? "" : String.valueOf(v);
                if (!a.values().isEmpty() && !a.values().contains(cell)) { ok = false; break; }
                if (!a.contains().isEmpty() && !cell.toLowerCase(java.util.Locale.ROOT).contains(a.contains())) { ok = false; break; }
            }
            if (ok) kept.add(r);
        }
        return new io.reporthub.reportstudio.service.ViewExportService.Table(t.columns(), kept);
    }

    /**
     * Exports the result of hand-typed SQL as a file without saving it first (Ad-hoc screen · SQL tab).
     *
     * Runs server-side and writes the file from the full result — not just the rows the screen loaded,
     * which was the trap of the old client-side export button. SELECT only (see ViewExportService.runSql).
     */
    @PostMapping("/repository/execute/export")
    public org.springframework.http.ResponseEntity<byte[]> executeExport(
            @RequestParam(defaultValue = "csv") String format,
            @Valid @RequestBody ExecRequest req) {
        var table = applyFilters(views.runSql(req.datasourceId(), req.sql(), req.values()), req.filters());
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
            case "csv" -> {
                body = views.toCsv(table);
                ext = ".csv";
                mime = org.springframework.http.MediaType.parseMediaType("text/csv; charset=UTF-8");
            }
            default -> throw new BadRequestException("Unknown export format: " + format);
        }
        String filename = "query_" + java.time.LocalDateTime.now()
                .format(java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd-HHmm")) + ext;
        return org.springframework.http.ResponseEntity.ok()
                .contentType(mime)
                .contentLength(body.length)
                .header(org.springframework.http.HttpHeaders.CONTENT_DISPOSITION,
                        org.springframework.http.ContentDisposition.attachment().filename(filename).build().toString())
                .body(body);
    }
}
