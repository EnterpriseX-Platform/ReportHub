package io.reporthub.reportstudio.service;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.DatasetDef;
import io.reporthub.reportstudio.domain.Datasource;
import io.reporthub.reportstudio.repo.DatasetDefRepository;
import io.reporthub.reportstudio.repo.DatasourceRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * User-defined datasets: a SELECT statement against a datasource (the internal warehouse, or a
 * real PostgreSQL/Oracle connection configured on the datasource). Queries are restricted to a
 * single SELECT; aggregation requests are built by wrapping the dataset SQL as a sub-select with
 * identifiers validated against the dataset's own column list and values bound as parameters.
 */
@Service
@Transactional(readOnly = true)
public class DatasetService {

    public record Column(String name, String kind) {}                       // kind: dim | measure
    public record TableResult(List<String> columns, List<List<Object>> rows, int rowCount) {}

    private final DatasetDefRepository datasets;
    private final DatasourceRepository datasources;
    private final JdbcTemplate internalJdbc;
    private final com.fasterxml.jackson.databind.ObjectMapper json;

    public DatasetService(DatasetDefRepository datasets,
                          DatasourceRepository datasources,
                          JdbcTemplate internalJdbc,
                          com.fasterxml.jackson.databind.ObjectMapper json) {
        this.datasets = datasets;
        this.datasources = datasources;
        this.internalJdbc = internalJdbc;
        this.json = json;
    }

    private static boolean isCaptured(DatasetDef d) {
        return "captured".equals(d.getCaptureMode()) && d.getColumnsJson() != null;
    }

    private static String captureTable(DatasetDef d) {
        return "ds_cap_" + d.getId();
    }

    /** Level-3 row filters; optional so the service can be built without them. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.rowfilter.RowFilterService rowFilters;

    /**
     * FROM-clause source of a dataset for the current caller: the captured table or the source
     * query, wrapped in the caller's row filters. Filter values are appended to {@code binds},
     * which therefore must come before any binds of the outer query.
     */
    private String source(DatasetDef d, List<Object> binds) {
        String base = isCaptured(d) ? "SELECT * FROM " + captureTable(d) : d.getSqlText();
        if (rowFilters == null) return isCaptured(d) ? captureTable(d) : "(" + d.getSqlText() + ") rs_q";
        var c = rowFilters.wrapJdbc(io.reporthub.reportstudio.rowfilter.RowFilterService.DATASET,
                String.valueOf(d.getId()), base, binds);
        if (c.sql().equals(base)) {
            return isCaptured(d) ? captureTable(d) : "(" + d.getSqlText() + ") rs_q";
        }
        return "(" + c.sql() + ") rs_q";
    }

    public DatasetDef require(Long id) {
        return datasets.findById(id).orElseThrow(() -> new NotFoundException("Dataset not found: " + id));
    }

    /**
     * Single-SELECT guard — no semicolons, must start with SELECT/WITH.
     *
     * <p>Judged on {@link #codeOnly} rather than the raw text, because a comment is not a
     * statement and a word inside a literal is not a keyword. A generated pipeline could not be
     * saved at all: its SQL opens with the generator's `-- ====` banner, so the
     * old first-word test read "--" and refused a query that is a plain SELECT. The same trap on
     * the other side — `WHERE note = 'delete me'` was rejected as containing "delete ".
     *
     * <p>This is not a loosening. A `--` comment cannot hide an executable statement (it runs to
     * end of line), a literal cannot become one, and everything the database would execute is
     * still checked.
     */
    public static void validateSql(String sql) {
        if (sql == null || sql.isBlank()) throw new BadRequestException("SQL is required");
        String t = codeOnly(sql).trim().toLowerCase(Locale.ROOT);
        if (t.isBlank()) throw new BadRequestException("SQL is required");
        if (t.contains(";")) throw new BadRequestException("Only a single statement is allowed (no ';')");
        if (!(t.startsWith("select") || t.startsWith("with"))) {
            throw new BadRequestException("Only SELECT queries are allowed");
        }
        for (String banned : new String[]{"insert ", "update ", "delete ", "drop ", "alter ", "truncate ", "grant ", "create "}) {
            if (t.contains(banned)) throw new BadRequestException("Statement contains a forbidden keyword: " + banned.trim());
        }
    }

    /**
     * The statement with comments and string literals blanked out — what the database will actually
     * execute, with nothing left that only looks like SQL. Lengths are preserved loosely (each
     * removed run becomes a single space) since only the text matters, not offsets.
     */
    static String codeOnly(String sql) {
        StringBuilder out = new StringBuilder(sql.length());
        int i = 0;
        while (i < sql.length()) {
            char c = sql.charAt(i);
            boolean two = i + 1 < sql.length();
            if (c == '-' && two && sql.charAt(i + 1) == '-') {
                int nl = sql.indexOf('\n', i);
                i = nl < 0 ? sql.length() : nl;
                out.append(' ');
            } else if (c == '/' && two && sql.charAt(i + 1) == '*') {
                int end = sql.indexOf("*/", i + 2);
                i = end < 0 ? sql.length() : end + 2;
                out.append(' ');
            } else if (c == '\'' || c == '"') {
                int j = i + 1;
                while (j < sql.length()) {
                    if (sql.charAt(j) == c) {
                        if (j + 1 < sql.length() && sql.charAt(j + 1) == c) { j += 2; continue; } // '' escape
                        j++;
                        break;
                    }
                    j++;
                }
                i = j;
                out.append(c).append(c);   // keep an empty literal so `= ''` still parses as code
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    /** Run the dataset SQL (LIMITed) and return columns + rows — powers the editor preview. */
    public TableResult preview(String datasourceId, String sql, int limit) {
        validateSql(sql);
        AppDatabaseGuard.checkSql(sql);
        String wrapped = "SELECT * FROM (" + sql + ") rs_q" + limitClause(datasourceId, limit);
        return execute(datasourceId, wrapped, List.of());
    }

    /**
     * dim | measure, by type only: numeric columns are measures, everything else dimensions.
     * Numeric columns that should group instead (a numeric year or code) are listed explicitly on
     * the dataset ({@link DatasetDef#getDimensionColumns()}); names are never guessed.
     */
    static String kindOf(String name, int sqlType) {
        return kindOf(name, sqlType, java.util.Set.of());
    }

    static String kindOf(String name, int sqlType, java.util.Set<String> dimensionColumns) {
        if (!isNumeric(sqlType)) return "dim";
        if (name != null && dimensionColumns.contains(name.toUpperCase(java.util.Locale.ROOT))) return "dim";
        return "measure";
    }

    /** The dataset's configured dimension columns, upper-cased. */
    static java.util.Set<String> dimensionColumns(DatasetDef d) {
        String csv = d == null ? null : d.getDimensionColumns();
        if (csv == null || csv.isBlank()) return java.util.Set.of();
        java.util.Set<String> out = new java.util.HashSet<>();
        for (String s : csv.split(",")) if (!s.isBlank()) out.add(s.trim().toUpperCase(java.util.Locale.ROOT));
        return out;
    }

    /** Preview of an existing dataset's SQL with the caller's row filters for that dataset applied. */
    public TableResult previewFiltered(String datasourceId, String sql, Long datasetId, int limit) {
        validateSql(sql);
        AppDatabaseGuard.checkSql(sql);
        List<Object> binds = new ArrayList<>();
        String q = sql;
        if (rowFilters != null) {
            q = rowFilters.wrapJdbc(io.reporthub.reportstudio.rowfilter.RowFilterService.DATASET,
                    String.valueOf(datasetId), sql, binds).sql();
        }
        String wrapped = "SELECT * FROM (" + q + ") rs_q" + limitClause(datasourceId, limit);
        return execute(datasourceId, wrapped, binds);
    }

    /** Guarded lookup for parameter dropdowns: SELECT-only, values bound, rows capped. */
    public TableResult lookup(String datasourceId, String sql, List<Object> binds, int limit) {
        validateSql(sql);
        String wrapped = "SELECT * FROM (" + sql + ") rs_q" + limitClause(datasourceId, limit);
        return execute(datasourceId, wrapped, binds);
    }

    /** Columns of the dataset classified as dimension (text/date) or measure (numeric). */
    public List<Column> fields(DatasetDef d) {
        if (isCaptured(d)) {
            try {
                return json.readValue(d.getColumnsJson(),
                        json.getTypeFactory().constructCollectionType(List.class, Column.class));
            } catch (Exception e) {
                throw new BadRequestException("Captured column metadata unreadable — re-capture the dataset");
            }
        }
        String wrapped = "SELECT * FROM (" + d.getSqlText() + ") rs_q" + limitClause(d.getDatasourceId(), 1);
        java.util.Set<String> dims = dimensionColumns(d);
        List<Column> out = new ArrayList<>();
        withConnection(d.getDatasourceId(), (con) -> {
            try (PreparedStatement ps = con.prepareStatement(wrapped); ResultSet rs = ps.executeQuery()) {
                ResultSetMetaData md = rs.getMetaData();
                for (int i = 1; i <= md.getColumnCount(); i++) {
                    out.add(new Column(md.getColumnLabel(i), kindOf(md.getColumnLabel(i), md.getColumnType(i), dims)));
                }
            }
            return null;
        });
        return out;
    }

    /** Distinct values of a dimension column (for filter dropdowns). */
    public List<String> distinct(DatasetDef d, String field) {
        String col = validColumn(d, field);
        List<Object> binds = new ArrayList<>();
        String src = source(d, binds);
        TableResult r = isCaptured(d)
                ? execute(null, "SELECT DISTINCT " + col + " FROM " + src + " ORDER BY 1 LIMIT 200", binds)
                : execute(d.getDatasourceId(), "SELECT DISTINCT " + col + " FROM " + src + " ORDER BY 1"
                        + limitClause(d.getDatasourceId(), 200), binds);
        return r.rows().stream().map(row -> row.get(0) == null ? "" : String.valueOf(row.get(0))).toList();
    }

    /** Grouped aggregation over the dataset: SUM(measures) GROUP BY dims with equality filters. */
    /** Aggregate SQL; AVG is rounded to {@value #AVG_SCALE} decimals (raw averages carry ~20 digits). */
    static String aggExpr(String fn, String col) {
        if ("avg".equals(fn)) return "ROUND(CAST(AVG(" + col + ") AS NUMERIC), " + AVG_SCALE + ")";
        return fn.toUpperCase(java.util.Locale.ROOT) + "(" + col + ")";
    }

    static final int AVG_SCALE = 4;

    public TableResult aggregate(DatasetDef d, List<String> dims, List<String> measures,
                                 Map<String, String> filters) {
        return aggregate(d, dims, measures, filters, SCREEN_ROWS);
    }

    /** Rows the ad-hoc screen shows. */
    public static final int SCREEN_ROWS = 1000;
    /** Rows an Excel export may carry — the screen cap would silently truncate the file. */
    public static final int EXPORT_ROWS = 100_000;

    /**
     * As {@link #aggregate(DatasetDef, List, List, Map)}, with the row cap chosen by the caller.
     * The screen reads 1,000 rows; an export must not inherit that cap, or the workbook comes out
     * short with nothing on screen to say so.
     */
    public TableResult aggregate(DatasetDef d, List<String> dims, List<String> measures,
                                 Map<String, String> filters, int maxRows) {
        return aggregate(d, dims, measures, filters, maxRows, null);
    }

    /** Aggregate functions the widgets may ask for. */
    public static final java.util.Set<String> AGGS = java.util.Set.of("sum", "avg", "min", "max", "count");

    public TableResult aggregate(DatasetDef d, List<String> dims, List<String> measures,
                                 Map<String, String> filters, int maxRows, String agg) {
        String fn = agg == null || agg.isBlank() ? "sum" : agg.trim().toLowerCase(java.util.Locale.ROOT);
        if (!AGGS.contains(fn)) throw new BadRequestException("agg must be one of sum, avg, min, max, count");
        if (measures.isEmpty()) throw new BadRequestException("Pick at least one measure");
        List<Column> cols = fields(d);
        List<String> dimCols = dims.stream().map(f -> validColumn(cols, f)).toList();
        List<String> meaCols = measures.stream().map(f -> validColumn(cols, f)).toList();

        StringBuilder sql = new StringBuilder("SELECT ");
        sql.append(String.join(", ", dimCols));
        if (!dimCols.isEmpty()) sql.append(", ");
        sql.append(meaCols.stream().map(c -> aggExpr(fn, c) + " AS " + c).reduce((a, b) -> a + ", " + b).orElse(""));
        List<Object> binds = new ArrayList<>();
        sql.append(" FROM ").append(source(d, binds));

        if (filters != null && !filters.isEmpty()) {
            List<String> conds = new ArrayList<>();
            for (var e : filters.entrySet()) {
                if (e.getValue() == null || e.getValue().isBlank()) continue;
                conds.add(validColumn(cols, e.getKey()) + " = ?");
                binds.add(e.getValue());
            }
            if (!conds.isEmpty()) sql.append(" WHERE ").append(String.join(" AND ", conds));
        }
        if (!dimCols.isEmpty()) {
            sql.append(" GROUP BY ").append(String.join(", ", dimCols))
               .append(" ORDER BY ").append(String.join(", ", dimCols));
        }
        sql.append(isCaptured(d) ? " LIMIT " + maxRows : limitClause(d.getDatasourceId(), maxRows));
        return execute(isCaptured(d) ? null : d.getDatasourceId(), sql.toString(), binds);
    }

    // ---- capture (materialize the source query into a local snapshot table) ----

    /**
     * Run the source SQL once and store the rows in a real warehouse table
     * ({@code ds_cap_<id>}), freezing column metadata. Ad-hoc and dashboard reads
     * then hit the snapshot instead of the source. Capped at {@code maxRows}.
     */
    @Transactional
    public DatasetDef capture(DatasetDef d, int maxRows) {
        validateSql(d.getSqlText());
        String wrapped = "SELECT * FROM (" + d.getSqlText() + ") rs_q" + limitClause(d.getDatasourceId(), maxRows);

        // Pull rows + column kinds from the SOURCE connection.
        java.util.Set<String> dims = dimensionColumns(d);
        record Snapshot(List<Column> cols, List<List<Object>> rows) {}
        Snapshot snap = withConnection(d.getDatasourceId(), (con) -> {
            try (PreparedStatement ps = con.prepareStatement(wrapped); ResultSet rs = ps.executeQuery()) {
                ResultSetMetaData md = rs.getMetaData();
                List<Column> cols = new ArrayList<>();
                for (int i = 1; i <= md.getColumnCount(); i++) {
                    cols.add(new Column(md.getColumnLabel(i), kindOf(md.getColumnLabel(i), md.getColumnType(i), dims)));
                }
                List<List<Object>> rows = new ArrayList<>();
                while (rs.next()) {
                    List<Object> row = new ArrayList<>(cols.size());
                    for (int i = 1; i <= cols.size(); i++) {
                        Object v = rs.getObject(i);
                        if ("measure".equals(cols.get(i - 1).kind())) {
                            row.add(v == null ? null : ((Number) (v instanceof Number n ? n : Double.parseDouble(String.valueOf(v)))).doubleValue());
                        } else {
                            row.add(v == null ? null : String.valueOf(v));
                        }
                    }
                    rows.add(row);
                }
                return new Snapshot(cols, rows);
            }
        });
        if (snap.cols().isEmpty()) throw new BadRequestException("Query returned no columns");

        // (Re)build the snapshot table in the internal warehouse and bulk-insert.
        String table = captureTable(d);
        StringBuilder ddl = new StringBuilder("CREATE TABLE " + table + " (");
        for (int i = 0; i < snap.cols().size(); i++) {
            if (i > 0) ddl.append(", ");
            ddl.append("\"").append(snap.cols().get(i).name()).append("\"")
               .append("measure".equals(snap.cols().get(i).kind()) ? " NUMERIC" : " TEXT");
        }
        ddl.append(")");
        internalJdbc.execute("DROP TABLE IF EXISTS " + table);
        internalJdbc.execute(ddl.toString());

        String placeholders = String.join(", ", java.util.Collections.nCopies(snap.cols().size(), "?"));
        String insert = "INSERT INTO " + table + " VALUES (" + placeholders + ")";
        internalJdbc.batchUpdate(insert, snap.rows(), 500, (ps, row) -> {
            for (int i = 0; i < row.size(); i++) ps.setObject(i + 1, row.get(i));
        });

        try {
            d.setColumnsJson(json.writeValueAsString(snap.cols()));
        } catch (Exception e) {
            throw new BadRequestException("Column metadata not serializable");
        }
        d.setCaptureMode("captured");
        d.setCapturedAt(java.time.OffsetDateTime.now());
        d.setCaptureRows(snap.rows().size());
        return datasets.save(d);
    }

    /** Drop the snapshot and return the dataset to live mode. */
    @Transactional
    public DatasetDef uncapture(DatasetDef d) {
        internalJdbc.execute("DROP TABLE IF EXISTS " + captureTable(d));
        d.setCaptureMode("live");
        d.setCapturedAt(null);
        d.setCaptureRows(null);
        d.setColumnsJson(null);
        return datasets.save(d);
    }

    // ---- plumbing ----

    /** Reject any field that is not a real column of the dataset (injection guard). */
    private String validColumn(DatasetDef d, String field) {
        return validColumn(fields(d), field);
    }

    /**
     * Same guard, against a column list the caller already holds.
     *
     * <p>{@link #fields(DatasetDef)} opens its own connection and probes the source query, so
     * resolving each dimension and measure separately cost one Oracle round trip per column. On
     * a large source table that was several seconds each and pushed the ad-hoc export past the
     * edge timeout before the real query had even started.
     */
    private static String validColumn(List<Column> cols, String field) {
        return cols.stream().map(Column::name)
                .filter(n -> n.equalsIgnoreCase(field)).findFirst()
                .map(n -> "\"" + n + "\"")
                .orElseThrow(() -> new BadRequestException("Unknown column: " + field));
    }

    private String limitClause(String datasourceId, int limit) {
        return isOracle(datasourceId) ? " FETCH FIRST " + limit + " ROWS ONLY" : " LIMIT " + limit;
    }

    private boolean isOracle(String datasourceId) {
        if (datasourceId == null) return false;
        return datasources.findById(datasourceId)
                .map(ds -> ds.getJdbcUrl() != null && ds.getJdbcUrl().startsWith("jdbc:oracle"))
                .orElse(false);
    }

    private TableResult execute(String datasourceId, String sql, List<Object> binds) {
        return withConnection(datasourceId, (con) -> {
            try (PreparedStatement ps = con.prepareStatement(sql)) {
                // Filter / parameter values arrive as text; coerce them to the parameter types.
                io.reporthub.reportstudio.util.TypedValues.bindAll(ps, binds);
                try (ResultSet rs = ps.executeQuery()) {
                    ResultSetMetaData md = rs.getMetaData();
                    List<String> cols = new ArrayList<>();
                    for (int i = 1; i <= md.getColumnCount(); i++) cols.add(md.getColumnLabel(i));
                    List<List<Object>> rows = new ArrayList<>();
                    while (rs.next()) {
                        List<Object> row = new ArrayList<>(cols.size());
                        for (int i = 1; i <= cols.size(); i++) {
                            Object v = rs.getObject(i);
                            row.add(v instanceof java.sql.Timestamp || v instanceof java.sql.Date
                                    ? String.valueOf(v) : v);
                        }
                        rows.add(row);
                    }
                    return new TableResult(cols, rows, rows.size());
                }
            }
        });
    }

    private interface SqlWork<T> { T run(Connection con) throws Exception; }

    /**
     * Use the datasource's real JDBC connection when configured; else the internal warehouse.
     * When a datasource is explicitly selected it MUST have a usable JDBC connection — we never
     * silently fall back to the internal Postgres warehouse for it, because running an Oracle
     * query there yields a misleading "relation ... does not exist" error.
     */
    private <T> T withConnection(String datasourceId, SqlWork<T> work) {
        Datasource ds = null;
        if (datasourceId != null && !datasourceId.isBlank()) {
            ds = datasources.findById(datasourceId)
                    .orElseThrow(() -> new BadRequestException("Datasource not found: " + datasourceId));
            if (ds.getJdbcUrl() == null || ds.getJdbcUrl().isBlank()) {
                throw new BadRequestException("Datasource '" + ds.getName()
                        + "' has no JDBC connection configured — set its JDBC URL and credentials on the Datasources page");
            }
            AppDatabaseGuard.checkDatasourceUrl(ds.getJdbcUrl());
        }
        try {
            if (ds != null) {
                DriverManager.setLoginTimeout(5);
                try (Connection con = DriverManager.getConnection(ds.getJdbcUrl(), ds.getDbUser(), ds.getDbPassword())) {
                    con.setReadOnly(true);
                    return work.run(con);
                }
            }
            try (Connection con = internalJdbc.getDataSource().getConnection()) {
                return work.run(con);
            }
        } catch (BadRequestException be) {
            throw be;
        } catch (Exception e) {
            // Same hint the warehouse and check runs attach — a preview is where an author is most
            // likely to meet ORA-00942/00911 and least likely to know what the code means.
            throw new BadRequestException("Query failed: " + WarehouseService.friendly(e.getMessage()));
        }
    }

    private static boolean isNumeric(int sqlType) {
        return switch (sqlType) {
            case Types.TINYINT, Types.SMALLINT, Types.INTEGER, Types.BIGINT,
                 Types.FLOAT, Types.REAL, Types.DOUBLE, Types.NUMERIC, Types.DECIMAL -> true;
            default -> false;
        };
    }
}
