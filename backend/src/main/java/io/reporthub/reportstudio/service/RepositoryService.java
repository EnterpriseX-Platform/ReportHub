package io.reporthub.reportstudio.service;

import org.springframework.stereotype.Service;
import io.reporthub.reportstudio.web.BadRequestException;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Database Tool ( "Repository"): browse tables of any configured datasource, page through
 * their rows, edit/insert/delete rows, and run ad-hoc SQL. All table/column identifiers are
 * validated against the live catalog and quoted, and every write is parameterized, so the only SQL
 * a caller can inject is via the explicit SQL Editor (which is keyword-guarded).
 */
@Service
public class RepositoryService {

    public record TableInfo(String schema, String name, String type) {}
    public record ColumnInfo(String name, String type, int sqlType, boolean nullable, boolean pk) {}
    public record TableMeta(String schema, String name, List<ColumnInfo> columns, List<String> primaryKey) {}
    /**
     * One page of a table.
     *
     * @param rowCount rows on THIS page
     * @param total    rows the filter matches in the whole table, or -1 when it was not asked for.
     *                 Separate from {@code rowCount} because the screen needs both: one to render,
     *                 the other to say how many pages there are.
     */
    public record Rows(List<String> columns, List<List<Object>> rows, int rowCount, long total) {}
    /** kind=select → columns/rows populated; kind=update → affected populated. */
    public record ExecResult(String kind, List<String> columns, List<List<Object>> rows, int rowCount, int affected) {}

    private final DbConnections db;

    /**
     * Filter for one column from the column header "funnel" (Excel-style).
     *
     * @param column   column name — always checked via {@link #validColumns} against the live catalog
     * @param values   ticked values (several = IN) · empty = no value-list filter
     * @param contains search text (case-insensitive) · empty = no text filter
     *
     * <p>Both together = ticked values <b>and</b> must contain the text (ANDed).
     */
    public record ColFilter(String column, List<String> values, String contains) {}

    /** Max ticked values per column — longer would not survive the URL, and long IN lists hurt the database. */
    private static final int MAX_FILTER_VALUES = 500;
    /** Max columns filtered at once — guards against bloated payloads. */
    private static final int MAX_FILTER_COLUMNS = 20;
    /** Max search text length per column — longer does not help find anything but makes LIKE costlier. */
    private static final int MAX_CONTAINS_LEN = 200;

    /**
     * Builds the single WHERE shared by every path (page · row count · export · funnel options).
     *
     * <p>Previously the WHERE-building code was duplicated verbatim in 4 places, so adding a new filter
     * type and forgetting one of them failed very quietly (an exported file not matching the screen, no error).
     *
     * @param ph placeholder factory — JDBC emits {@code ?} and records the value to bind later, while exports
     *           that store SQL for the worker to run later emit {@code $P{name}}. Every value is always bound;
     *           <b>never concatenate into the SQL</b> (and never {@code $P!{}}, which is substituted raw).
     */
    private String whereClause(TableMeta m, Map<String, String> equals, List<ColFilter> filters,
                               java.util.function.Function<Object, String> ph) {
        return whereClause(m, equals, filters, "", ph);
    }

    /**
     * @param alias column-name prefix, e.g. {@code "C."} for queries that alias the table
     *              — empty = bare names
     */
    /** Level-3 row filters (optional so the service can be built without them). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.rowfilter.RowFilterService rowFilters;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.repo.RepoTableRepository registry;

    /**
     * The caller's row filters for this physical table (rules of every registry entry that points at
     * it), with columns resolved against the live catalog and values bound through {@code ph}.
     */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.acl.AclService acl;

    private io.reporthub.reportstudio.rowfilter.RowFilterSql.Condition rowFilter(
            TableMeta m, String alias, java.util.function.Function<Object, String> ph) {
        return rowFilter(m, alias, ph, "view");
    }

    /**
     * Also the level-2 gate for table data: when the table is registered, the caller needs
     * {@code perm} on at least one of its registry entries (entries without ACL are open).
     */
    private io.reporthub.reportstudio.rowfilter.RowFilterSql.Condition rowFilter(
            TableMeta m, String alias, java.util.function.Function<Object, String> ph, String perm) {
        if (rowFilters == null || registry == null
                || io.reporthub.reportstudio.rowfilter.RowFilterService.subject() == null) {
            return io.reporthub.reportstudio.rowfilter.RowFilterSql.NONE;
        }
        List<String> ids = registry.findForPhysicalTable(m.schema(), m.name()).stream()
                .map(t -> String.valueOf(t.getId())).toList();
        if (acl != null && !ids.isEmpty() && ids.stream().noneMatch(id -> acl.allowed("REPO_TABLE", id, perm))) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.FORBIDDEN, "No " + perm + " access to table " + m.name());
        }
        String a = alias == null ? "" : alias;
        return rowFilters.condition(io.reporthub.reportstudio.rowfilter.RowFilterService.REPO_TABLE, ids,
                c -> a + quote(validColumns(m, java.util.Set.of(c)).get(0)), ph);
    }

    private String whereClause(TableMeta m, Map<String, String> equals, List<ColFilter> filters,
                               String alias, java.util.function.Function<Object, String> ph) {
        String a = alias == null ? "" : alias;
        List<String> parts = new ArrayList<>();
        var rf = rowFilter(m, a, ph);
        if (!rf.isEmpty()) parts.add(rf.sql());

        if (equals != null && !equals.isEmpty()) {
            // Map keys are the names the user/registry typed; c is the catalog name — case may differ.
            //    A plain equals.get(c) would return null and become "= NULL", silently returning 0 rows.
            Map<String, String> ci = new java.util.TreeMap<>(String.CASE_INSENSITIVE_ORDER);
            ci.putAll(equals);
            for (String c : validColumns(m, equals.keySet())) {
                parts.add(a + quote(c) + " = " + ph.apply(coerce(ci.get(c), sqlTypeOf(m, c))));
            }
        }

        if (filters != null && !filters.isEmpty()) {
            if (filters.size() > MAX_FILTER_COLUMNS) {
                throw new BadRequestException("At most " + MAX_FILTER_COLUMNS + " columns can be filtered at once");
            }
            for (ColFilter f : filters) {
                if (f == null || f.column() == null || f.column().isBlank()) continue;
                boolean hasValues = f.values() != null && !f.values().isEmpty();
                boolean hasText = f.contains() != null && !f.contains().isBlank();
                if (!hasValues && !hasText) continue;
                String c = validColumns(m, java.util.Set.of(f.column())).get(0);
                assertFilterable(m, c);
                if (hasValues) {
                    List<String> vs = f.values();
                    if (vs.size() > MAX_FILTER_VALUES) {
                        throw new BadRequestException("At most " + MAX_FILTER_VALUES
                                + " values can be selected per column (" + c + ")");
                    }
                    int t = sqlTypeOf(m, c);
                    parts.add(a + quote(c) + " IN (" + String.join(", ",
                            vs.stream().map((v) -> ph.apply(coerce(v, t))).toList()) + ")");
                }
                if (hasText) {
                    String q = f.contains().trim();
                    if (q.length() > MAX_CONTAINS_LEN) q = q.substring(0, MAX_CONTAINS_LEN);
                    // Text columns: UPPER(column) directly (CLOB-safe). Other types (numbers, dates,
                    // booleans) are cast to text first - Postgres has no UPPER(integer).
                    // User-typed % and _ must be escaped or they become wildcards.
                    String colExpr = io.reporthub.reportstudio.util.TypedValues.isText(sqlTypeOf(m, c))
                            ? a + quote(c) : "CAST(" + a + quote(c) + " AS VARCHAR(4000))";
                    parts.add("UPPER(" + colExpr + ") LIKE " + ph.apply("%" + likeEscape(q).toUpperCase() + "%")
                            + " ESCAPE '\\'");
                }
            }
        }
        return parts.isEmpty() ? "" : " WHERE " + String.join(" AND ", parts);
    }

    /** User-typed \ % _ must become literal characters, not wildcards. */
    private static String likeEscape(String s) {
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    /**
     * Large-object columns (CLOB/BLOB/LONG/RAW) cannot be filtered — Oracle throws ORA-00932/ORA-00997,
     * which reaches the screen as an unreadable raw message, so reject it clearly up front instead.
     */
    private static void assertFilterable(TableMeta m, String col) {
        for (ColumnInfo ci : m.columns()) {
            if (!ci.name().equalsIgnoreCase(col)) continue;
            String t = ci.type() == null ? "" : ci.type().toUpperCase();
            if (t.contains("LOB") || t.startsWith("LONG") || t.contains("RAW") || t.contains("BFILE")) {
                throw new BadRequestException("Column " + col + " has type " + ci.type() + " — it cannot be filtered");
            }
            return;
        }
    }

    /**
     * App-wide cap on concurrent "filter options" queries. Many concurrent DISTINCT queries on a very large
     * table can starve the database of buffer cache and stall every other session, including ETL jobs. Four slots fit one screen (up to 4 filter columns) — a second screen waits briefly in
     * the app instead of queuing inside the database.
     */
    private final java.util.concurrent.Semaphore optionSlots = new java.util.concurrent.Semaphore(4);

    public RepositoryService(DbConnections db) {
        this.db = db;
    }

    // ---- catalog -----------------------------------------------------------

    /** User tables of the datasource (or the internal warehouse when datasourceId is blank). */
    public List<TableInfo> tables(String datasourceId) {
        return db.withConnection(datasourceId, true, (con) -> {
            DatabaseMetaData md = con.getMetaData();
            String schemaFilter = oracleSchema(con, datasourceId);
            // On the application's own database, never offer ReportHub's internal tables
            // (users, ACLs, jobs, …) — for anyone, admins included.
            boolean appDb = AppDatabaseGuard.isAppDatabase(md.getURL());
            List<TableInfo> out = new ArrayList<>();
            try (ResultSet rs = md.getTables(con.getCatalog(), schemaFilter, "%",
                    new String[]{"TABLE", "VIEW"})) {
                while (rs.next()) {
                    String schema = rs.getString("TABLE_SCHEM");
                    String name = rs.getString("TABLE_NAME");
                    String type = rs.getString("TABLE_TYPE");
                    if (name == null) continue;
                    if (isSystemSchema(schema)) continue;
                    if (appDb && isAppTable(name)) continue;
                    out.add(new TableInfo(schema, name, type));
                }
            }
            out.sort((a, b) -> a.name().compareToIgnoreCase(b.name()));
            return out;
        });
    }

    /** Sample/demo data tables created by migrations — real data, so they stay listable. */
    private static final java.util.Set<String> DEMO_TABLES = java.util.Set.of("fact", "m_branch", "ref_branch", "ref_region");
    private static volatile java.util.Set<String> appTables;

    /** ReportHub's own tables: every table a Flyway migration creates (minus demo data) + Flyway's history. */
    static boolean isAppTable(String name) {
        java.util.Set<String> t = appTables;
        if (t == null) {
            java.util.Set<String> found = new java.util.HashSet<>();
            found.add("flyway_schema_history");
            java.util.regex.Pattern p = java.util.regex.Pattern.compile(
                    "(?i)create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:[a-z_]+\\.)?\"?([a-z_][a-z0-9_]*)");
            try {
                var res = new org.springframework.core.io.support.PathMatchingResourcePatternResolver()
                        .getResources("classpath*:db/migration/*.sql");
                for (var r : res) {
                    try (var in = r.getInputStream()) {
                        var m = p.matcher(new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
                        while (m.find()) found.add(m.group(1).toLowerCase(java.util.Locale.ROOT));
                    }
                }
            } catch (java.io.IOException ignored) { /* fall back to what was found */ }
            found.removeAll(DEMO_TABLES);
            appTables = t = java.util.Set.copyOf(found);
        }
        return name != null && t.contains(name.toLowerCase(java.util.Locale.ROOT));
    }

    public TableMeta meta(String datasourceId, String schema, String table) {
        return db.withConnection(datasourceId, true, (con) -> describe(con, datasourceId, schema, table));
    }

    private TableMeta describe(Connection con, String datasourceId, String schema, String table) throws Exception {
        DatabaseMetaData md = con.getMetaData();
        String sch = resolveSchema(con, datasourceId, schema, table);
        AppDatabaseGuard.checkSchema(sch);
        Set<String> pk = new LinkedHashSet<>();
        try (ResultSet rs = md.getPrimaryKeys(con.getCatalog(), sch, table)) {
            while (rs.next()) pk.add(rs.getString("COLUMN_NAME"));
        }
        List<ColumnInfo> cols = new ArrayList<>();
        try (ResultSet rs = md.getColumns(con.getCatalog(), sch, table, "%")) {
            while (rs.next()) {
                String name = rs.getString("COLUMN_NAME");
                String type = rs.getString("TYPE_NAME");
                int sqlType = rs.getInt("DATA_TYPE");
                boolean nullable = rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls;
                cols.add(new ColumnInfo(name, type, sqlType, nullable, pk.contains(name)));
            }
        }
        if (cols.isEmpty()) throw new BadRequestException("Table not found: " + table);
        return new TableMeta(sch, table, cols, new ArrayList<>(pk));
    }

    // ---- data --------------------------------------------------------------

    /**
     *               meant to show one slice of a table (e.g. a branch registry filtered to one
     *               fixed PARENT_ID) passes them instead of getting the whole table. Columns are
     *               a fixed PARENT_ID) passes them instead of getting the whole table. Columns are
     *               checked against the live catalog and the values are bound, and the predicate is
     *               only built when something is actually passed — an unfiltered browse keeps its
     *               own statement rather than carrying a dead WHERE.
     */
    public Rows rows(String datasourceId, String schema, String table, int limit, int offset,
                     Map<String, String> equals, boolean withTotal) {
        return rows(datasourceId, schema, table, limit, offset, equals, withTotal, false);
    }

    /**
     * @param withRowId prepend {@code ROWID} as the first column (Oracle only) — the screen asks for it only
     *                  on tables configured with ROWID as their key; tables with a PK do not need it
     */
    public Rows rows(String datasourceId, String schema, String table, int limit, int offset,
                     Map<String, String> equals, boolean withTotal, boolean withRowId) {
        return rows(datasourceId, schema, table, limit, offset, equals, withTotal, withRowId, null);
    }

    public Rows rows(String datasourceId, String schema, String table, int limit, int offset,
                     Map<String, String> equals, boolean withTotal, boolean withRowId,
                     List<ColFilter> filters) {
        return rows(datasourceId, schema, table, limit, offset, equals, withTotal, withRowId, filters, null);
    }

    /**
     * @param sort {@code COLUMN}, {@code COLUMN,asc}, {@code COLUMN,desc} or {@code -COLUMN}; blank = the
     *             stable default (primary key columns, else the first column). Checked against the catalog.
     */
    public Rows rows(String datasourceId, String schema, String table, int limit, int offset,
                     Map<String, String> equals, boolean withTotal, boolean withRowId,
                     List<ColFilter> filters, String sort) {
        int lim = Math.min(Math.max(limit, 1), 1000);
        int off = Math.max(offset, 0);
        return db.withConnection(datasourceId, true, (con) -> {
            TableMeta m = describe(con, datasourceId, schema, table);
            String fq = qualify(m.schema(), m.name());
            boolean oracle = db.isOracle(datasourceId);
            List<Object> binds = new ArrayList<>();
            String where = whereClause(m, equals, filters, (v) -> { binds.add(v); return "?"; });
            // ROWID must be referenced through a table alias, otherwise "SELECT ROWID, * ..." is invalid syntax
            String pick = (oracle && withRowId) ? "T_." + ROWID_COL + " AS \"" + ROWID_COL + "\", T_.*" : "*";
            String from = (oracle && withRowId) ? fq + " T_" : fq;
            String order = orderBy(m, sort);
            String sql = oracle
                    ? "SELECT " + pick + " FROM " + from + where + order + " OFFSET " + off + " ROWS FETCH NEXT " + lim + " ROWS ONLY"
                    : "SELECT * FROM " + fq + where + order + " LIMIT " + lim + " OFFSET " + off;
            long total = -1;
            String ck = countKey(datasourceId, schema, table, equals, filters);
            CountHit hit = withTotal ? countCache.get(ck) : null;
            if (hit != null
                    && System.currentTimeMillis() - hit.atMs() < (hit.total() < 0 ? COUNT_TTL_FAIL_MS : COUNT_TTL_OK_MS)) {
                total = hit.total();
            } else if (withTotal) {
                // Counted separately, and only when the screen asks: the page query is bounded by
                // FETCH NEXT but a COUNT reads the whole filtered set, which can be hundreds of thousands of
                // rows. Paying it on every page click would make paging slower the further you go —
                // the screen asks once per filter change and reuses the answer.
                try (PreparedStatement cs = con.prepareStatement("SELECT COUNT(*) FROM " + fq + where)) {
                    int j = 1;
                    for (Object b : binds) cs.setObject(j++, b);
                    cs.setQueryTimeout(COUNT_TIMEOUT_SECONDS);
                    try (ResultSet rs = cs.executeQuery()) { rs.next(); total = rs.getLong(1); }
                } catch (Exception e) {
                    // A total is a convenience; the grid must still open. Falling back to -1 puts the
                    // screen back on plain next/prev rather than failing the whole read.
                    total = -1;
                }
                countCache.put(ck, new CountHit(total, System.currentTimeMillis()));
            }
            try (PreparedStatement ps = con.prepareStatement(sql)) {
                int i = 1;
                for (Object b : binds) ps.setObject(i++, b);
                // This path used to have no time limit. As long as every term is "= ?" it can use an index,
                // but a header "contains…" filter is LIKE '%…%', which cannot — so without a limit one bad
                // search would hang until a reverse proxy times it out with an unreadable 502.
                ps.setQueryTimeout(ROWS_TIMEOUT_SECONDS);
                try (ResultSet rs = ps.executeQuery()) {
                    Rows r = readRows(rs);
                    return new Rows(r.columns(), r.rows(), r.rowCount(), total);
                }
            }
        });
    }

    /**
     * Stable ORDER BY for paging and exports: the requested sort column first (validated against the
     * live catalog), then the key columns, else the first column, so pages never overlap or skip rows.
     */
    static String orderBy(TableMeta m, String sort) {
        List<String> terms = new ArrayList<>();
        Set<String> used = new java.util.HashSet<>();
        if (sort != null && !sort.isBlank()) {
            for (String part : sort.split(";")) {
                String p = part.trim();
                if (p.isEmpty()) continue;
                boolean desc = false;
                if (p.startsWith("-")) { desc = true; p = p.substring(1).trim(); }
                int comma = p.lastIndexOf(',');
                if (comma < 0) comma = p.lastIndexOf(':');
                if (comma > 0) {
                    String dir = p.substring(comma + 1).trim().toLowerCase(Locale.ROOT);
                    if (!dir.equals("asc") && !dir.equals("desc")) {
                        throw new BadRequestException("Sort direction must be asc or desc: " + dir);
                    }
                    desc = dir.equals("desc");
                    p = p.substring(0, comma).trim();
                }
                String c = validColumns(m, Set.of(p)).get(0);
                if (isRowId(c)) throw new BadRequestException("Cannot sort by " + c);
                if (used.add(c.toUpperCase(Locale.ROOT))) terms.add(quote(c) + (desc ? " DESC" : " ASC"));
            }
        }
        List<String> keys = m.primaryKey().isEmpty() && !m.columns().isEmpty()
                ? List.of(m.columns().get(0).name()) : m.primaryKey();
        for (String k : keys) {
            if (used.add(k.toUpperCase(Locale.ROOT))) terms.add(quote(k));
        }
        return terms.isEmpty() ? "" : " ORDER BY " + String.join(", ", terms);
    }

    /** A page must not wait on a count; 10s is already generous for an indexed COUNT. */
    private static final int COUNT_TIMEOUT_SECONDS = 10;

    /** Page query time limit — below typical reverse-proxy timeouts so the user gets a real message, not a 502. */
    private static final int ROWS_TIMEOUT_SECONDS = 25;

    /**
     * Row-count cache — stops tables that are too slow to count from being recounted every time a screen opens.
     *
     * <p>Measured: the Tables sidebar requests the row count of <b>every registered table</b> each time it
     * opens. One very large table took <b>~11 seconds</b> and returned -1 (hitting COUNT_TIMEOUT_SECONDS),
     * burning 10 seconds of database time every time for no number at all. It is partitioned by a
     * string-concatenated virtual column, so Oracle cannot prune partitions from a single year predicate and
     * must read all ~5.5 million rows each time.
     *
     * <p>Short TTL for successful counts (totals must stay fresh after edits) and a much longer one for
     * failures, since a table that cannot be counted in 10 seconds will not suddenly finish next minute.
     */
    private record CountHit(long total, long atMs) { }
    private static final long COUNT_TTL_OK_MS = 30_000L;
    private static final long COUNT_TTL_FAIL_MS = 10 * 60_000L;
    private final java.util.Map<String, CountHit> countCache = new java.util.concurrent.ConcurrentHashMap<>();

    private static String countKey(String datasourceId, String schema, String table,
                                   Map<String, String> equals, List<ColFilter> filters) {
        // Forgetting filters here = a previous filter set's row count would be silently reused
        StringBuilder f = new StringBuilder();
        if (filters != null) {
            for (ColFilter x : filters) {
                if (x == null) continue;
                f.append(x.column()).append('=').append(x.values()).append('~').append(x.contains()).append(';');
            }
        }
        // Row filters differ per caller, so a cached total is only reused by the same user.
        String who = io.reporthub.reportstudio.iam.CurrentPrincipal.get()
                .map(p -> p.tenantId() + "/" + p.username()).orElse("");
        return who + "|" + datasourceId + "|" + schema + "|" + table + "|"
                + (equals == null ? "" : new java.util.TreeMap<>(equals)) + "|" + f;
    }

    /** Drops all cached counts for this table — call after writes, or totals go stale after insert/delete. */
    private void forgetCounts(String datasourceId, String schema, String table) {
        String prefix = datasourceId + "|" + schema + "|" + table + "|";
        countCache.keySet().removeIf((k) -> k.startsWith(prefix));
    }

    /**
     * Every row of the (filtered) table written to {@code out} as one downloadable file — originally for a
     * pipe-delimited .txt submission file, and the same shape
     * covers .xlsx and .csv. Same WHERE construction as {@link #rows}, no paging.
     *
     * <p>Not capped. It used to refuse anything over 50,000 rows, which meant the main extract
     * — the one this step exists to produce — could not be exported at all (one year is ~200,000 rows).
     * The cap was removed rather than making the user
     * slice the data up by hand and glue it back together, which is its own way to ship a wrong
     * file. Truncation was never the alternative; the old cap refused outright, and so does any
     * failure here — the file is fully written before a single response byte goes out.
     *
     * <p>The ResultSet is iterated directly (never {@code readRows}, which buffers everything) with
     * an explicit fetch size — the Oracle driver's default is 10, which would mean thousands of round
     * trips for a single mid-size table.
     *
     * @return row count actually written
     */
    public int export(String datasourceId, String schema, String table, Map<String, String> equals,
                      String format, java.io.OutputStream out) {
        return export(datasourceId, schema, table, equals, null, format, out);
    }

    public int export(String datasourceId, String schema, String table, Map<String, String> equals,
                      List<ColFilter> filters, String format, java.io.OutputStream out) {
        return export(datasourceId, schema, table, equals, filters, null, format, out);
    }

    /** Same WHERE and ORDER BY as {@link #rows} — the file matches the grid exactly. */
    public int export(String datasourceId, String schema, String table, Map<String, String> equals,
                      List<ColFilter> filters, String sort, String format, java.io.OutputStream out) {
        return db.withConnection(datasourceId, true, (con) -> {
            TableMeta m = describe(con, datasourceId, schema, table);
            String fq = qualify(m.schema(), m.name());
            List<Object> binds = new ArrayList<>();
            String where = whereClause(m, equals, filters, (v) -> { binds.add(v); return "?"; });

            // setFetchSize alone does nothing on pgjdbc: it streams only with autocommit off and a
            // forward-only cursor, otherwise the whole result set is materialised on the heap
            // before the first next(). WarehouseService.load() already had to learn this.
            boolean restoreAutoCommit = false;
            if (!db.isOracle(datasourceId) && con.getAutoCommit()) {
                con.setAutoCommit(false);
                restoreAutoCommit = true;
            }
            try (PreparedStatement ps = con.prepareStatement("SELECT * FROM " + fq + where + orderBy(m, sort))) {
                int i = 1;
                for (Object b : binds) ps.setObject(i++, b);
                ps.setFetchSize(1000);
                ps.setQueryTimeout(EXPORT_TIMEOUT_SECONDS);
                try (ResultSet rs = ps.executeQuery()) {
                    return switch (format) {
                        case "txt" -> writeDelimited(rs, out, "|", false);
                        case "csv" -> writeDelimited(rs, out, ",", true);
                        case "xlsx" -> writeXlsxIntegers(rs, out);
                        default -> throw new BadRequestException("Unknown export format: " + format);
                    };
                }
            } finally {
                if (restoreAutoCommit) {
                    try { con.rollback(); con.setAutoCommit(true); } catch (Exception ignored) { /* closing anyway */ }
                }
            }
        });
    }

    /**
     * Per-statement. Raised along with the row cap, so exports of a few hundred thousand rows can
     * finish; a short timeout only ever made sense for exports small enough not to need it.
     *
     * <p>The edge can still give up before a file this size is written, and that is a real limit
     * this number cannot fix: the file is generated in full before the first response byte, so a
     * long export is invisible to the caller until it either arrives or times out. Whether that
     * needs the response to start streaming earlier is a separate decision from the cap.
     */
    private static final int EXPORT_TIMEOUT_SECONDS = 900;

    /**
     * {@code csvQuote=false} is the external system's pipe format: bare values, no quoting — so a pipe, CR or
     * LF inside a value would corrupt the field/line structure of the whole file. Those characters
     * are replaced with a space (they do not legitimately occur in this data; names and
     * OUTPUT_NAME are the only free text). CSV mode quotes properly instead, and gets a UTF-8 BOM
     * so Excel opens non-ASCII text correctly — same choice as ReportRenderer's CSV export.
     */
    private static int writeDelimited(ResultSet rs, java.io.OutputStream out, String sep, boolean csvQuote)
            throws Exception {
        ResultSetMetaData md = rs.getMetaData();
        int cols = md.getColumnCount();
        var w = new java.io.BufferedWriter(new java.io.OutputStreamWriter(out, java.nio.charset.StandardCharsets.UTF_8), 1 << 16);
        if (csvQuote) w.write('﻿');
        for (int c = 1; c <= cols; c++) {
            if (c > 1) w.write(sep);
            w.write(cell(md.getColumnLabel(c), sep, csvQuote));
        }
        w.write("\r\n");
        int n = 0;
        while (rs.next()) {
            ++n;
            for (int c = 1; c <= cols; c++) {
                if (c > 1) w.write(sep);
                Object v = norm(rs.getObject(c));
                w.write(v == null ? "" : cell(String.valueOf(v), sep, csvQuote));
            }
            w.write("\r\n");
        }
        w.flush();
        return n;
    }

    private static String cell(String s, String sep, boolean csvQuote) {
        if (csvQuote) {
            if (s.contains(sep) || s.contains("\"") || s.contains("\n") || s.contains("\r")) {
                return "\"" + s.replace("\"", "\"\"") + "\"";
            }
            return s;
        }
        return s.replace(sep, " ").replace("\r", " ").replace("\n", " ");
    }

    /** {@link #writeXlsx} through a temp file so whole numbers are stored as integers ({@code 250}, not {@code 250.0}). */
    private static int writeXlsxIntegers(ResultSet rs, java.io.OutputStream out) throws Exception {
        java.nio.file.Path tmp = java.nio.file.Files.createTempFile("rs-tbl-", ".xlsx");
        try {
            int n;
            try (java.io.OutputStream f = java.nio.file.Files.newOutputStream(tmp)) { n = writeXlsx(rs, f); }
            try (java.io.InputStream in = java.nio.file.Files.newInputStream(tmp)) {
                io.reporthub.reportstudio.render.XlsxIntegers.rewrite(in, out);
            }
            return n;
        } finally {
            java.nio.file.Files.deleteIfExists(tmp);
        }
    }

    /** Streaming workbook, same settings as ReportRenderer (window 200, compressed temp files). */
    private static int writeXlsx(ResultSet rs, java.io.OutputStream out) throws Exception {
        ResultSetMetaData md = rs.getMetaData();
        int cols = md.getColumnCount();
        try (var wb = new org.apache.poi.xssf.streaming.SXSSFWorkbook(200)) {
            wb.setCompressTempFiles(true);
            var sheet = wb.createSheet("data");
            var head = sheet.createRow(0);
            for (int c = 1; c <= cols; c++) head.createCell(c - 1).setCellValue(md.getColumnLabel(c));
            int n = 0;
            while (rs.next()) {
                ++n;
                var row = sheet.createRow(n);
                for (int c = 1; c <= cols; c++) {
                    Object v = norm(rs.getObject(c));
                    if (v == null) continue;
                    var cell = row.createCell(c - 1);
                    if (v instanceof Number num) cell.setCellValue(num.doubleValue());
                    else cell.setCellValue(String.valueOf(v));
                }
            }
            wb.write(out);
            wb.dispose();
            return n;
        }
    }

    /** One entry of a filter picker: the value that gets filtered on, and what to read on screen. */
    public record Option(String value, String label) {}

    /**
     * Distinct values of one column, for a filter picker, each with a readable label.
     *
     * <p>Capped and optionally narrowed by {@code q}, because the columns people filter these
     * screens by are not all small: a region column may have a few dozen values but a branch column
     * thousands, and shipping all of them
     * into a dropdown makes the screen useless in a different way. Every column name goes through
     * {@link #validColumns} against the live catalogue, so none is interpolated unchecked.
     *
     * <p>{@code labelSource} says where the name beside the code comes from (shown as "code name"), and
     * has two shapes because the tables genuinely differ:
     * <ul>
     *   <li>{@code REGION_NAME} — a column of this same table. Tables that carry their own name
     *       columns use them, since that name is the one their own rows were built with.
     *   <li>{@code core.M_BRANCH.BRANCH_CODE.BRANCH_NAME} — {@code SCHEMA.TABLE.CODE.NAME}, for tables that
     *       hold codes only (e.g. an interface file whose spec has code fields and no name fields).
     * </ul>
     * Null or blank means no label, and the value is its own label.
     *
     * <p>Grouped rather than DISTINCT on the pair: a lookup table may keep a row per fiscal year, so one
     * code can have two spellings of its name. Picking one keeps a code from appearing twice in a
     * dropdown, which would read as duplicate branches.
     *
     * <p>The search matches the label too. Typing a branch's name has to find it — searching only
     * the code would mean you must already know the number you came to look up.
     */
    /**
     * @param optionsFrom a small lookup table holding the possible values of this column, as
     *                    {@code SCHEMA.TABLE.CODE.NAME} — when set, options are read from it instead of
     *                    scanning the data table.
     *
     *                    <p>Measured: {@code GROUP BY} on a very wide, very large table (hundreds of
     *                    columns · millions of rows) can never be fast enough for a dropdown, even
     *                    with year and step conditions — it is partitioned by a string-concatenated virtual
     *                    column, so Oracle cannot prune partitions from the separate predicates (the plan shows
     *                    PARTITION LIST ALL), and even pruned it takes ~20 s per picker.
     *
     *                    <p>The values already live in master tables (branches, process steps), so reading
     *                    the small table is not caching (nothing to refresh) — just asking the right place.
     */
    public List<Option> distinct(String datasourceId, String schema, String table, String column,
                                 String labelSource, String q, int limit, Map<String, String> equals,
                                 String optionsFrom) {
        return distinct(datasourceId, schema, table, column, labelSource, q, limit, equals, optionsFrom, null);
    }

    /**
     * @param filters filters from other columns' funnels — the tickable value list narrows to what is filtered,
     *                like Excel (pick a branch and the category list shows only that branch's categories).
     *                The column's own filter must be dropped, otherwise the list shrinks to the values already
     *                ticked and the user can never change their mind.
     */
    public List<Option> distinct(String datasourceId, String schema, String table, String column,
                                 String labelSource, String q, int limit, Map<String, String> equals,
                                 String optionsFrom, List<ColFilter> filters) {
        int lim = Math.min(Math.max(limit, 1), 500);

        // Options from a small lookup table skip the queue — the queue guards DISTINCT queries on real data
        // tables (tens of GB), not 7-row views. With header funnels, several pickers request options at once,
        // the 4 slots fill easily, and pickers that lose the race showed "could not load options" when they
        // had merely failed to get a slot (users hit it on the year picker).
        if (optionsFrom != null && !optionsFrom.isBlank()) {
            return optionsFromLookup(datasourceId, optionsFrom, q, lim, equals);
        }

        // Acquire a slot before opening a connection — this caps both concurrent queries and open connections
        // (DbConnections opens a fresh one each time, no pool). Wait briefly so pickers of one screen take turns.
        boolean slot;
        try {
            slot = optionSlots.tryAcquire(5, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BadRequestException("Interrupted while waiting to load options");
        }
        if (!slot) throw new BadRequestException("Other options are still loading — please try again");
        try {
        List<ColFilter> others = filters == null ? List.of() : filters.stream()
                .filter((f) -> f != null && f.column() != null && !f.column().equalsIgnoreCase(column))
                .toList();
        return db.withConnection(datasourceId, true, (con) -> {
            TableMeta m = describe(con, datasourceId, schema, table);
            String col = validColumns(m, java.util.Set.of(column)).get(0);
            boolean oracle = db.isOracle(datasourceId);
            boolean search = q != null && !q.isBlank();

            String labelExpr = null;
            String join = "";
            if (labelSource != null && !labelSource.isBlank()) {
                String[] p = labelSource.trim().split("\\.");
                if (p.length == 4) {
                    TableMeta lm = describe(con, datasourceId, p[0], p[1]);
                    String lcode = validColumns(lm, java.util.Set.of(p[2])).get(0);
                    String lname = validColumns(lm, java.util.Set.of(p[3])).get(0);
                    join = " LEFT JOIN " + qualify(lm.schema(), lm.name()) + " L ON L." + quote(lcode)
                            + " = C." + quote(col);
                    labelExpr = "L." + quote(lname);
                } else if (p.length == 1) {
                    labelExpr = "C." + quote(validColumns(m, java.util.Set.of(p[0])).get(0));
                } else {
                    throw new BadRequestException(
                            "labelSource must be a column of the same table or SCHEMA.TABLE.CODE.NAME: " + labelSource);
                }
            }

            // Filters the screen holds (e.g. year and step) arrive via equals — more important than it looks: a
            // partitioned table turns "scan everything" into "read one partition" when
            // those values are in the WHERE. The column being loaded must not be filtered by itself, or the
            // options shrink to the values already chosen.
            List<String> eqCols = equals == null || equals.isEmpty()
                    ? List.of()
                    : validColumns(m, equals.keySet()).stream().filter(c -> !c.equals(col)).toList();
            String value = "C." + quote(col);
            StringBuilder wb = new StringBuilder(" WHERE " + value + " IS NOT NULL");
            for (String c : eqCols) wb.append(" AND C.").append(quote(c)).append(" = ?");
            // Filters from other columns' funnels — same builder as the other paths, with alias C. added
            List<Object> fBinds = new ArrayList<>();
            String fWhere = whereClause(m, null, others, "C.", (v) -> { fBinds.add(v); return "?"; });
            if (!fWhere.isBlank()) wb.append(" AND ").append(fWhere.substring(" WHERE ".length()));
            if (search) wb.append(" AND (UPPER(").append(value).append(") LIKE ?")
                    .append(labelExpr == null ? "" : " OR UPPER(" + labelExpr + ") LIKE ?").append(")");
            String where = wb.toString();
            String sql = "SELECT " + value + " AS V, "
                    + (labelExpr == null ? "NULL" : "MIN(" + labelExpr + ")") + " AS L"
                    + " FROM " + qualify(m.schema(), m.name()) + " C" + join + where
                    + " GROUP BY " + value + " ORDER BY 1 "
                    + (oracle ? "FETCH NEXT " + lim + " ROWS ONLY" : "LIMIT " + lim);
            try (PreparedStatement ps = con.prepareStatement(sql)) {
                int i = 1;
                for (String c : eqCols) ps.setObject(i++, coerce(equals.get(c), sqlTypeOf(m, c)));
                for (Object b : fBinds) ps.setObject(i++, b);
                if (search) {
                    String like = "%" + q.trim().toUpperCase() + "%";
                    ps.setString(i++, like);
                    if (labelExpr != null) ps.setString(i, like);
                }
                // A reverse proxy may cut sync requests off — options arriving later are never seen anyway.
                // Letting queries run on after a 502 is what once piled up 37 database sessions.
                ps.setQueryTimeout(OPTIONS_TIMEOUT_SECONDS);
                try (ResultSet rs = ps.executeQuery()) {
                    List<Option> out = new ArrayList<>();
                    while (rs.next()) {
                        Object v = rs.getObject(1);
                        if (v == null) continue;
                        Object l = rs.getObject(2);
                        out.add(new Option(String.valueOf(v), l == null ? null : String.valueOf(l)));
                    }
                    return out;
                }
            }
        });
        } finally {
            optionSlots.release();
        }
    }

    /** Options query limit — well under typical reverse-proxy timeouts so the connection is released before anyone presses F5. */
    private static final int OPTIONS_TIMEOUT_SECONDS = 15;

    /** Reads options from a small lookup table ({@code SCHEMA.TABLE.CODE.NAME}) instead of the data table. */
    /**
     * @param spec   {@code SCHEMA.TABLE.CODE.NAME} · may end with {@code @PARENT_COLUMN=FIELD}
     *               to narrow the list by a value the user already picked, e.g.
     *               {@code core.V_BRANCH.CODE.NAME@REGION_CODE=REGION} = once a region is picked,
     *               the branch picker shows only that region's branches
     * @param equals filters the screen currently holds — only the field named in spec is used.
     *               Not all of them can be applied: these lookup tables do not share the data table's columns.
     */
    private List<Option> optionsFromLookup(String datasourceId, String spec, String q, int lim,
                                           Map<String, String> equals) {
        String[] at = spec.trim().split("@", 2);
        String[] p = at[0].trim().split("\\.");
        if (p.length != 4) {
            throw new BadRequestException("Options source must be SCHEMA.TABLE.CODE.NAME: " + spec);
        }
        String parentCol = null, parentVal = null;
        if (at.length == 2) {
            String[] kv = at[1].split("=", 2);
            if (kv.length != 2 || kv[0].isBlank() || kv[1].isBlank()) {
                throw new BadRequestException("Parent condition must be @PARENT_COLUMN=FIELD: " + spec);
            }
            parentCol = kv[0].trim();
            // Field names compare case-insensitively — the registry may write REGION while the screen sends the real column name
            String want = kv[1].trim();
            if (equals != null) {
                for (Map.Entry<String, String> e : equals.entrySet()) {
                    if (e.getKey() != null && e.getKey().trim().equalsIgnoreCase(want)
                            && e.getValue() != null && !e.getValue().isBlank()) {
                        parentVal = e.getValue().trim();
                    }
                }
            }
        }
        final String pCol = parentCol, pVal = parentVal;
        return db.withConnection(datasourceId, true, (con) -> {
            TableMeta lm = describe(con, datasourceId, p[0], p[1]);
            // the lookup table's own ACL and row filters, exactly as when it is read as a table
            var rf = rowFilter(lm, "C.", x -> "?");
            String code = validColumns(lm, java.util.Set.of(p[2])).get(0);
            String name = validColumns(lm, java.util.Set.of(p[3])).get(0);
            // No parent picked yet = no filter (show everything), not zero options
            String parent = pCol == null || pVal == null
                    ? null : "C." + quote(validColumns(lm, java.util.Set.of(pCol)).get(0));
            boolean oracle = db.isOracle(datasourceId);
            boolean search = q != null && !q.isBlank();
            String v = "C." + quote(code), l = "C." + quote(name);
            // MIN(name): a lookup keeping a row per fiscal year can spell one code's name several ways —
            // collapse to one row, otherwise the dropdown shows duplicates that read as different branches
            String sql = "SELECT " + v + " AS V, MIN(" + l + ") AS L FROM " + qualify(lm.schema(), lm.name()) + " C"
                    + " WHERE " + v + " IS NOT NULL"
                    + (parent == null ? "" : " AND " + parent + " = ?")
                    + (search ? " AND (UPPER(" + v + ") LIKE ? OR UPPER(" + l + ") LIKE ?)" : "")
                    + (rf.isEmpty() ? "" : " AND (" + rf.sql() + ")")
                    + " GROUP BY " + v + " ORDER BY 1 "
                    + (oracle ? "FETCH NEXT " + lim + " ROWS ONLY" : "LIMIT " + lim);
            try (PreparedStatement ps = con.prepareStatement(sql)) {
                int i = 1;
                if (parent != null) ps.setString(i++, pVal);
                if (search) {
                    String like = "%" + q.trim().toUpperCase() + "%";
                    ps.setString(i++, like);
                    ps.setString(i++, like);
                }
                for (Object b : rf.binds()) ps.setObject(i++, b);
                ps.setQueryTimeout(OPTIONS_TIMEOUT_SECONDS);
                try (ResultSet rs = ps.executeQuery()) {
                    List<Option> out = new ArrayList<>();
                    while (rs.next()) {
                        Object val = rs.getObject(1);
                        if (val == null) continue;
                        Object lab = rs.getObject(2);
                        out.add(new Option(String.valueOf(val), lab == null ? null : String.valueOf(lab)));
                    }
                    return out;
                }
            }
        });
    }

    /** SQL + bound values for queueing an export job — does not run it, only assembles it for the 'sql' engine. */
    public record ExportSql(String sql, Map<String, Object> params, String schema, String table) {}

    /**
     * Builds the export statement for one table (with the filters the screen holds) for the real export
     * system to run in the background, instead of pulling the whole table on the request thread.
     *
     * <p>Why: {@link #export} writes the whole file before sending the first byte — for a very large table the
     * request hangs for many minutes, a reverse proxy may cut it off, and the database query keeps running. The export system runs as a background job, streams
     * row by row, can be cancelled, shows progress and keeps the file in object storage for later download.
     *
     * <p>Column names go through {@link #validColumns} against the live catalog like every path; user-entered
     * values travel as {@code $P{...}}, which the engine binds rather than concatenating into the statement.
     */
    /**
     * @param columns column order wanted in the file — null/empty = {@code SELECT *} in the table's real order
     *
     *                <p>So the exported file is <b>ordered as seen on screen</b>. Screen order comes from the
     *                registry, not from reordering real columns (Oracle cannot do that in place), so a
     *                SELECT * export would always differ from the screen.
     *                Every name goes through {@link #validColumns} first, and a LinkedHashSet is used to
     *                <b>keep the requested order</b> (a plain Set would scramble it).
     */
    public ExportSql exportSql(String datasourceId, String schema, String table,
                               Map<String, String> equals, String year, List<String> columns) {
        return exportSql(datasourceId, schema, table, equals, null, year, columns);
    }

    public ExportSql exportSql(String datasourceId, String schema, String table,
                               Map<String, String> equals, List<ColFilter> filters,
                               String year, List<String> columns) {
        return exportSql(datasourceId, schema, table, equals, filters, year, columns, null);
    }

    /**
     * @param labels column headers to use in the file when they differ from the real names ({@code COLUMN -> name})
     *               — some target systems use different names than the database .
     *               New names must be letters/digits/underscore only and at most 30 characters
     *               (Oracle's limit); anything else is dropped, never concatenated into SQL.
     */
    public ExportSql exportSql(String datasourceId, String schema, String table,
                               Map<String, String> equals, List<ColFilter> filters,
                               String year, List<String> columns, Map<String, String> labels) {
        return exportSql(datasourceId, schema, table, equals, filters, year, columns, labels, null);
    }

    public ExportSql exportSql(String datasourceId, String schema, String table,
                               Map<String, String> equals, List<ColFilter> filters,
                               String year, List<String> columns, Map<String, String> labels, String sort) {
        return exportSql(datasourceId, schema, table, equals, filters, year, columns, labels, sort, null);
    }

    /**
     * @param yearColumn the column the optional {@code year} filters on, as configured for the table
     *                   (never guessed from column names); required when {@code year} is given
     */
    public ExportSql exportSql(String datasourceId, String schema, String table,
                               Map<String, String> equals, List<ColFilter> filters,
                               String year, List<String> columns, Map<String, String> labels, String sort,
                               String yearColumn) {
        return db.withConnection(datasourceId, true, (con) -> {
            TableMeta m = describe(con, datasourceId, schema, table);
            Map<String, Object> params = new java.util.LinkedHashMap<>();
            int[] seq = { 0 };
            StringBuilder w = new StringBuilder(whereClause(m, equals, filters, (v) -> {
                String name = "eq" + (seq[0]++);
                // The job payload is JSON: keep dates as ISO text (the worker re-coerces on bind).
                params.put(name, v instanceof java.util.Date ? v.toString() : v);
                return "$P{" + name + "}";
            }));
            // A year filter is applied only when the caller explicitly asks for one (year=YYYY); the
            // export must otherwise match the grid, which never adds a year on its own.
            String yearCol = yearColumn(m, yearColumn);
            boolean alreadyByYear = yearCol != null
                    && ((equals != null && equals.keySet().stream().anyMatch(c -> c.equalsIgnoreCase(yearCol)))
                        || (filters != null && filters.stream().anyMatch(f -> f != null
                             && f.column() != null && f.column().equalsIgnoreCase(yearCol))));
            String y = year == null ? null : year.trim();
            if (y != null && !y.isEmpty()) {
                if (yearCol == null) {
                    throw new BadRequestException("No year column is configured for this table - remove the year filter");
                }
                if (!y.matches("\\d{4}")) {
                    throw new BadRequestException("Year must be 4 digits: " + y);
                }
                if (!alreadyByYear) {
                    // Years are stored as four or two digits; bind both forms (they cannot collide).
                    params.put("fy", coerce(y, sqlTypeOf(m, yearCol)));
                    params.put("fy2", coerce(y.substring(2), sqlTypeOf(m, yearCol)));
                    w.append(w.isEmpty() ? " WHERE " : " AND ").append(quote(yearCol))
                     .append(" IN ($P{fy}, $P{fy2})");
                }
            }
            String select = "*";
            if (columns != null && !columns.isEmpty()) {
                java.util.LinkedHashSet<String> want = new java.util.LinkedHashSet<>();
                for (String c : columns) if (c != null && !c.isBlank()) want.add(c.trim());
                if (!want.isEmpty()) {
                    Map<String, String> as = new java.util.TreeMap<>(String.CASE_INSENSITIVE_ORDER);
                    if (labels != null) {
                        for (Map.Entry<String, String> e : labels.entrySet()) {
                            String v = e.getValue() == null ? "" : e.getValue().trim();
                            String lbl = safeLabel(v);
                            if (lbl != null) as.put(e.getKey(), lbl);
                        }
                    }
                    select = String.join(", ", validColumns(m, want).stream()
                            .map((c) -> as.containsKey(c) && !as.get(c).equalsIgnoreCase(c)
                                    ? quote(c) + " AS " + quote(as.get(c))
                                    : quote(c))
                            .toList());
                }
            }
            return new ExportSql("SELECT " + select + " FROM " + qualify(m.schema(), m.name()) + w
                    + orderBy(m, sort), params, m.schema(), m.name());
        });
    }

    /**
     * Export header label: any Unicode text is allowed (it is emitted as a quoted identifier, never
     * concatenated raw). Double quotes and control characters are removed; the result is capped at
     * 60 characters. Returns null when nothing usable is left.
     */
    static String safeLabel(String v) {
        if (v == null) return null;
        String t = v.replace("\"", "").replaceAll("\\p{Cntrl}", " ").trim();
        if (t.length() > 60) t = t.substring(0, 60).trim();
        return t.isEmpty() ? null : t;
    }

    /**
     * The configured year column resolved against the table's real columns · null = none configured.
     * A configured name the table does not have is an error, never silently ignored.
     */
    private static String yearColumn(TableMeta m, String configured) {
        if (configured == null || configured.isBlank()) return null;
        for (ColumnInfo ci : m.columns()) {
            if (ci.name().equalsIgnoreCase(configured.trim())) return ci.name();
        }
        throw new BadRequestException("Configured year column not found in the table: " + configured);
    }


    public int insert(String datasourceId, String schema, String table, Map<String, Object> values) {
        forgetCounts(datasourceId, schema, table);
        if (values == null || values.isEmpty()) throw new BadRequestException("No values to insert");
        return db.withConnection(datasourceId, false, (con) -> {
            TableMeta m = describe(con, datasourceId, schema, table);
            List<String> cols = validColumns(m, values.keySet());
            String fq = qualify(m.schema(), m.name());
            String colList = String.join(", ", cols.stream().map(RepositoryService::quote).toList());
            String binds = String.join(", ", cols.stream().map(c -> "?").toList());
            String sql = "INSERT INTO " + fq + " (" + colList + ") VALUES (" + binds + ")";
            try (PreparedStatement ps = con.prepareStatement(sql)) {
                int i = 1;
                for (String c : cols) ps.setObject(i++, coerce(values.get(c), sqlTypeOf(m, c)));
                return ps.executeUpdate();
            }
        });
    }

    // An update does not change the row count, so cached totals are kept (unlike insert/delete) — unless a
    // filtered column is edited, in which case the total can be off for at most the 30 s cache TTL; acceptable.
    public int update(String datasourceId, String schema, String table,
                      Map<String, Object> set, Map<String, Object> key) {
        if (set == null || set.isEmpty()) throw new BadRequestException("No columns to update");
        if (key == null || key.isEmpty()) throw new BadRequestException("A key (row identifier) is required to update");
        return db.withConnection(datasourceId, false, (con) -> {
            TableMeta m = describe(con, datasourceId, schema, table);
            List<String> setCols = validColumns(m, set.keySet());
            List<String> keyCols = validColumns(m, key.keySet());
            String fq = qualify(m.schema(), m.name());
            String setClause = String.join(", ", setCols.stream().map(c -> quote(c) + " = ?").toList());
            String whereClause = String.join(" AND ", keyCols.stream().map(RepositoryService::eqPredicate).toList());
            var rf = rowFilter(m, "", v -> "?", "edit");
            String sql = "UPDATE " + fq + " SET " + setClause + " WHERE " + whereClause
                    + (rf.isEmpty() ? "" : " AND " + rf.sql());
            try (PreparedStatement ps = con.prepareStatement(sql)) {
                int i = 1;
                for (String c : setCols) ps.setObject(i++, coerce(set.get(c), sqlTypeOf(m, c)));
                for (String c : keyCols) ps.setObject(i++, coerce(key.get(c), sqlTypeOf(m, c)));
                for (Object b : rf.binds()) ps.setObject(i++, b);
                return ps.executeUpdate();
            }
        });
    }

    public int deleteRow(String datasourceId, String schema, String table, Map<String, Object> key) {
        forgetCounts(datasourceId, schema, table);
        if (key == null || key.isEmpty()) throw new BadRequestException("A key (row identifier) is required to delete");
        return db.withConnection(datasourceId, false, (con) -> {
            TableMeta m = describe(con, datasourceId, schema, table);
            List<String> keyCols = validColumns(m, key.keySet());
            String fq = qualify(m.schema(), m.name());
            String whereClause = String.join(" AND ", keyCols.stream().map(RepositoryService::eqPredicate).toList());
            var rf = rowFilter(m, "", v -> "?", "edit");
            String sql = "DELETE FROM " + fq + " WHERE " + whereClause + (rf.isEmpty() ? "" : " AND " + rf.sql());
            try (PreparedStatement ps = con.prepareStatement(sql)) {
                int i = 1;
                for (String c : keyCols) ps.setObject(i++, coerce(key.get(c), sqlTypeOf(m, c)));
                for (Object b : rf.binds()) ps.setObject(i++, b);
                return ps.executeUpdate();
            }
        });
    }

    // ---- ad-hoc SQL editor -------------------------------------------------

    /** Single-statement SQL. SELECT/WITH returns rows; INSERT/UPDATE/DELETE/MERGE returns affected. */
    /** Runs the statement as written (no variable parsing) - used by pipelines/checks that resolve their own tokens. */
    public ExecResult execute(String datasourceId, String sql) {
        return run(datasourceId, sql, new io.reporthub.reportstudio.util.SqlVariables.Bound(sql, List.of()));
    }

    /**
     * @param params values for {@code $NAME} / {@code :name} variables in the statement; every
     *               variable is bound as a parameter. Missing values are a 400 listing the names.
     */
    public ExecResult execute(String datasourceId, String sql, Map<String, ?> params) {
        classify(sql);
        io.reporthub.reportstudio.util.SqlVariables.Bound bound;
        try {
            bound = io.reporthub.reportstudio.util.SqlVariables.bind(sql, params);
        } catch (IllegalArgumentException e) {
            throw new BadRequestException(e.getMessage());
        }
        return run(datasourceId, sql, bound);
    }

    private ExecResult run(String datasourceId, String sql, io.reporthub.reportstudio.util.SqlVariables.Bound bound) {
        String kind = classify(sql);
        AppDatabaseGuard.checkSql(sql);
        boolean readOnly = "select".equals(kind);
        return db.withConnection(datasourceId, readOnly, (con) -> {
            try (PreparedStatement ps = con.prepareStatement(bound.sql())) {
                io.reporthub.reportstudio.util.TypedValues.bindAll(ps, bound.values());
                if (readOnly) {
                    try (ResultSet rs = ps.executeQuery()) {
                        Rows r = readRows(rs);
                        return new ExecResult("select", r.columns(), r.rows(), r.rowCount(), 0);
                    }
                }
                int affected = ps.executeUpdate();
                return new ExecResult("update", List.of(), List.of(), 0, affected);
            }
        });
    }

    /** Statement kind guard for the SQL editor — single statement, no DDL. */
    public static String classify(String sql) {
        if (sql == null || sql.isBlank()) throw new BadRequestException("SQL is required");
        String t = sql.trim();

        // Judged on the statement with comments and literals blanked out (the database sees the
        // original — only this classification uses the stripped copy). Without it a script that
        // opens with a `-- what this does` banner is read as starting with "--" and refused, which
        // is most hand-written SQL; and a `;` or a keyword inside a comment or a literal counts as
        // if it were code. See DatasetService.codeOnly.
        t = DatasetService.codeOnly(t).trim();
        if (t.isBlank()) throw new BadRequestException("SQL is required");

        // A PL/SQL block is one statement that necessarily contains semicolons — every line inside
        // it ends with one. The no-';' rule below is about statement chaining and cannot be applied
        // here, so blocks are recognised first and handed to the driver whole. Loading data is not
        // always expressible as a single DML statement: procedures, cursors and multi-step logic
        // live in blocks, and refusing them means that work cannot be part of a chain at all.
        String head = t.toLowerCase(Locale.ROOT);
        if (head.startsWith("begin") || head.startsWith("declare") || head.startsWith("call ")) {
            return "block";
        }

        // allow a single trailing ';' but no statement chaining
        if (t.endsWith(";")) t = t.substring(0, t.length() - 1).trim();
        if (t.contains(";")) throw new BadRequestException("Only a single statement is allowed (no ';')");
        String l = t.toLowerCase(Locale.ROOT);
        for (String banned : new String[]{"drop ", "alter ", "truncate ", "grant ", "revoke ", "create "}) {
            if (l.startsWith(banned) || l.contains(" " + banned)) {
                throw new BadRequestException("Statement contains a forbidden keyword: " + banned.trim());
            }
        }
        if (l.startsWith("select") || l.startsWith("with")) return "select";
        if (l.startsWith("insert") || l.startsWith("update") || l.startsWith("delete") || l.startsWith("merge")) {
            return "update";
        }
        throw new BadRequestException(
                "Supported: SELECT / INSERT / UPDATE / DELETE / MERGE or a PL/SQL block (BEGIN … END; / DECLARE / CALL)");
    }

    // ---- helpers -----------------------------------------------------------

    private Rows readRows(ResultSet rs) throws Exception {
        ResultSetMetaData md = rs.getMetaData();
        int n = md.getColumnCount();
        List<String> cols = new ArrayList<>(n);
        for (int i = 1; i <= n; i++) cols.add(md.getColumnLabel(i));
        List<List<Object>> rows = new ArrayList<>();
        while (rs.next()) {
            List<Object> row = new ArrayList<>(n);
            for (int i = 1; i <= n; i++) row.add(norm(rs.getObject(i)));
            rows.add(row);
        }
        return new Rows(cols, rows, rows.size(), -1);
    }

    /**
     * Everything that is not plainly JSON-safe goes out as text.
     *
     * <p>This used to name the types to convert, which let the driver's own classes through: an
     * Oracle TIMESTAMP column arrives as {@code oracle.sql.TIMESTAMP}, which does NOT extend
     * {@link java.sql.Timestamp}, so it reached Jackson, which walked its getters, hit a
     * {@code ByteArrayInputStream} and failed the whole response with a 500. Every Oracle table
     * with a TIMESTAMP column was unreadable. Listing what IS safe instead means a driver type
     * nobody anticipated degrades to its {@code toString()} rather than breaking the page.
     */
    private static Object norm(Object v) {
        if (v == null) return null;
        if (v instanceof java.sql.Clob clob) {
            try { return clob.getSubString(1, (int) Math.min(clob.length(), 100_000)); }
            catch (Exception e) { return "[clob]"; }
        }
        if (v instanceof byte[]) return "[binary]";
        if (v instanceof String || v instanceof Number || v instanceof Boolean) return v;
        if (v instanceof java.sql.Timestamp ts) return timestampText(ts);
        return String.valueOf(v);
    }

    /** {@code 2025-01-31 10:20:30} - Timestamp.toString's trailing {@code .0} dropped; real fractions kept. */
    static String timestampText(java.sql.Timestamp ts) {
        String t = ts.toString();
        return ts.getNanos() == 0 && t.endsWith(".0") ? t.substring(0, t.length() - 2) : t;
    }

    private static int sqlTypeOf(TableMeta m, String col) {
        return m.columns().stream().filter(ci -> ci.name().equals(col)).map(ColumnInfo::sqlType)
                .findFirst().orElse(Types.VARCHAR);
    }

    /** The grid sends every cell as a String; coerce it to the column's JDBC type (shared helper). */
    static Object coerce(Object v, int sqlType) {
        return io.reporthub.reportstudio.util.TypedValues.coerce(v, sqlType);
    }

    /** Map requested keys to the table's real column names (case-insensitive), preserving order. */
    /**
     * Oracle's ROWID — the physical address of a row, not a table column, so it is not in ALL_TAB_COLUMNS
     * and no real column may use the name (Oracle forbids it) ⇒ it can never collide with a real column.
     *
     * Usable as the "key" of any table without a primary key, since it always identifies exactly one row.
     * But ROWID can change when a row moves (ALTER TABLE MOVE / shrink / partition key update), so the value
     *    the screen holds may be stale — a stale one gives UPDATE affected=0 (the screen warns), never another row.
     */
    public static final String ROWID_COL = "ROWID";

    private static boolean isRowId(String col) { return ROWID_COL.equalsIgnoreCase(col); }

    /** `ROWID = CHARTOROWID(?)` — bind as text and let Oracle convert explicitly, never by accident. */
    private static String eqPredicate(String col) {
        return isRowId(col) ? ROWID_COL + " = CHARTOROWID(?)" : quote(col) + " = ?";
    }

    private static List<String> validColumns(TableMeta m, Set<String> requested) {
        List<String> out = new ArrayList<>();
        for (String want : requested) {
            if (isRowId(want)) { out.add(ROWID_COL); continue; }
            String match = m.columns().stream().map(ColumnInfo::name)
                    .filter(n -> n.equalsIgnoreCase(want)).findFirst()
                    .orElseThrow(() -> new BadRequestException("Unknown column: " + want));
            out.add(match);
        }
        return out;
    }

    private static String qualify(String schema, String table) {
        return (schema == null || schema.isBlank() ? "" : quote(schema) + ".") + quote(table);
    }

    /** Double-quote an identifier; reject anything with a quote to keep it injection-safe. */
    private static String quote(String ident) {
        if (ident == null || ident.contains("\"")) throw new BadRequestException("Invalid identifier: " + ident);
        return "\"" + ident + "\"";
    }

    private static boolean isSystemSchema(String schema) {
        if (schema == null) return false;
        String s = schema.toUpperCase(Locale.ROOT);
        return s.equals("PG_CATALOG") || s.equals("INFORMATION_SCHEMA") || s.startsWith("PG_TOAST")
                || s.equals("SYS") || s.equals("SYSTEM") || s.equals("XDB") || s.equals("CTXSYS")
                || s.equals("MDSYS") || s.equals("OUTLN") || s.equals("DBSNMP");
    }

    /** Oracle exposes every schema via metadata — default the table filter to the login schema. */
    private static String oracleSchema(Connection con, String datasourceId) throws Exception {
        if (datasourceId == null || datasourceId.isBlank()) return null;          // internal Postgres
        if (!con.getMetaData().getURL().startsWith("jdbc:oracle")) return null;
        String s = con.getSchema();
        return (s == null || s.isBlank()) ? con.getMetaData().getUserName() : s;
    }

    private String resolveSchema(Connection con, String datasourceId, String schema, String table) throws Exception {
        if (schema != null && !schema.isBlank()) return schema;
        return oracleSchema(con, datasourceId);
    }
}
