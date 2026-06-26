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

    public DatasetDef require(Long id) {
        return datasets.findById(id).orElseThrow(() -> new NotFoundException("Dataset not found: " + id));
    }

    /** Single-SELECT guard — no semicolons, must start with SELECT/WITH. */
    public static void validateSql(String sql) {
        if (sql == null || sql.isBlank()) throw new BadRequestException("SQL is required");
        String t = sql.trim().toLowerCase(Locale.ROOT);
        if (t.contains(";")) throw new BadRequestException("Only a single statement is allowed (no ';')");
        if (!(t.startsWith("select") || t.startsWith("with"))) {
            throw new BadRequestException("Only SELECT queries are allowed");
        }
        for (String banned : new String[]{"insert ", "update ", "delete ", "drop ", "alter ", "truncate ", "grant ", "create "}) {
            if (t.contains(banned)) throw new BadRequestException("Statement contains a forbidden keyword: " + banned.trim());
        }
    }

    /** Run the dataset SQL (LIMITed) and return columns + rows — powers the editor preview. */
    public TableResult preview(String datasourceId, String sql, int limit) {
        validateSql(sql);
        String wrapped = "SELECT * FROM (" + sql + ") rs_q" + limitClause(datasourceId, limit);
        return execute(datasourceId, wrapped, List.of());
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
        List<Column> out = new ArrayList<>();
        withConnection(d.getDatasourceId(), (con) -> {
            try (PreparedStatement ps = con.prepareStatement(wrapped); ResultSet rs = ps.executeQuery()) {
                ResultSetMetaData md = rs.getMetaData();
                for (int i = 1; i <= md.getColumnCount(); i++) {
                    out.add(new Column(md.getColumnLabel(i), isNumeric(md.getColumnType(i)) ? "measure" : "dim"));
                }
            }
            return null;
        });
        return out;
    }

    /** Distinct values of a dimension column (for filter dropdowns). */
    public List<String> distinct(DatasetDef d, String field) {
        String col = validColumn(d, field);
        TableResult r = isCaptured(d)
                ? execute(null, "SELECT DISTINCT " + col + " FROM " + captureTable(d) + " ORDER BY 1 LIMIT 200", List.of())
                : execute(d.getDatasourceId(), "SELECT DISTINCT " + col + " FROM (" + d.getSqlText() + ") rs_q ORDER BY 1"
                        + limitClause(d.getDatasourceId(), 200), List.of());
        return r.rows().stream().map(row -> row.get(0) == null ? "" : String.valueOf(row.get(0))).toList();
    }

    /** Grouped aggregation over the dataset: SUM(measures) GROUP BY dims with equality filters. */
    public TableResult aggregate(DatasetDef d, List<String> dims, List<String> measures,
                                 Map<String, String> filters) {
        if (measures.isEmpty()) throw new BadRequestException("Pick at least one measure");
        List<String> dimCols = dims.stream().map(f -> validColumn(d, f)).toList();
        List<String> meaCols = measures.stream().map(f -> validColumn(d, f)).toList();

        StringBuilder sql = new StringBuilder("SELECT ");
        sql.append(String.join(", ", dimCols));
        if (!dimCols.isEmpty()) sql.append(", ");
        sql.append(meaCols.stream().map(c -> "SUM(" + c + ") AS " + c).reduce((a, b) -> a + ", " + b).orElse(""));
        if (isCaptured(d)) sql.append(" FROM ").append(captureTable(d));
        else sql.append(" FROM (").append(d.getSqlText()).append(") rs_q");

        List<Object> binds = new ArrayList<>();
        if (filters != null && !filters.isEmpty()) {
            List<String> conds = new ArrayList<>();
            for (var e : filters.entrySet()) {
                if (e.getValue() == null || e.getValue().isBlank()) continue;
                conds.add(validColumn(d, e.getKey()) + " = ?");
                binds.add(e.getValue());
            }
            if (!conds.isEmpty()) sql.append(" WHERE ").append(String.join(" AND ", conds));
        }
        if (!dimCols.isEmpty()) {
            sql.append(" GROUP BY ").append(String.join(", ", dimCols))
               .append(" ORDER BY ").append(String.join(", ", dimCols));
        }
        sql.append(isCaptured(d) ? " LIMIT 1000" : limitClause(d.getDatasourceId(), 1000));
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
        record Snapshot(List<Column> cols, List<List<Object>> rows) {}
        Snapshot snap = withConnection(d.getDatasourceId(), (con) -> {
            try (PreparedStatement ps = con.prepareStatement(wrapped); ResultSet rs = ps.executeQuery()) {
                ResultSetMetaData md = rs.getMetaData();
                List<Column> cols = new ArrayList<>();
                for (int i = 1; i <= md.getColumnCount(); i++) {
                    cols.add(new Column(md.getColumnLabel(i), isNumeric(md.getColumnType(i)) ? "measure" : "dim"));
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
        return fields(d).stream().map(Column::name)
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
                for (int i = 0; i < binds.size(); i++) ps.setObject(i + 1, binds.get(i));
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
            throw new BadRequestException("Query failed: " + e.getMessage());
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
