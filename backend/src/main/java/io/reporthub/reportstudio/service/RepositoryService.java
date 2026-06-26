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
    public record Rows(List<String> columns, List<List<Object>> rows, int rowCount) {}
    /** kind=select → columns/rows populated; kind=update → affected populated. */
    public record ExecResult(String kind, List<String> columns, List<List<Object>> rows, int rowCount, int affected) {}

    private final DbConnections db;

    public RepositoryService(DbConnections db) {
        this.db = db;
    }

    // ---- catalog -----------------------------------------------------------

    /** User tables of the datasource (or the internal warehouse when datasourceId is blank). */
    public List<TableInfo> tables(String datasourceId) {
        return db.withConnection(datasourceId, true, (con) -> {
            DatabaseMetaData md = con.getMetaData();
            String schemaFilter = oracleSchema(con, datasourceId);
            List<TableInfo> out = new ArrayList<>();
            try (ResultSet rs = md.getTables(con.getCatalog(), schemaFilter, "%",
                    new String[]{"TABLE", "VIEW"})) {
                while (rs.next()) {
                    String schema = rs.getString("TABLE_SCHEM");
                    String name = rs.getString("TABLE_NAME");
                    String type = rs.getString("TABLE_TYPE");
                    if (name == null) continue;
                    if (isSystemSchema(schema)) continue;
                    out.add(new TableInfo(schema, name, type));
                }
            }
            out.sort((a, b) -> a.name().compareToIgnoreCase(b.name()));
            return out;
        });
    }

    public TableMeta meta(String datasourceId, String schema, String table) {
        return db.withConnection(datasourceId, true, (con) -> describe(con, datasourceId, schema, table));
    }

    private TableMeta describe(Connection con, String datasourceId, String schema, String table) throws Exception {
        DatabaseMetaData md = con.getMetaData();
        String sch = resolveSchema(con, datasourceId, schema, table);
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

    public Rows rows(String datasourceId, String schema, String table, int limit, int offset) {
        int lim = Math.min(Math.max(limit, 1), 1000);
        int off = Math.max(offset, 0);
        return db.withConnection(datasourceId, true, (con) -> {
            TableMeta m = describe(con, datasourceId, schema, table);
            String fq = qualify(m.schema(), m.name());
            boolean oracle = db.isOracle(datasourceId);
            String sql = oracle
                    ? "SELECT * FROM " + fq + " OFFSET " + off + " ROWS FETCH NEXT " + lim + " ROWS ONLY"
                    : "SELECT * FROM " + fq + " LIMIT " + lim + " OFFSET " + off;
            try (PreparedStatement ps = con.prepareStatement(sql);
                 ResultSet rs = ps.executeQuery()) {
                return readRows(rs);
            }
        });
    }

    public int insert(String datasourceId, String schema, String table, Map<String, Object> values) {
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
            String whereClause = String.join(" AND ", keyCols.stream().map(c -> quote(c) + " = ?").toList());
            String sql = "UPDATE " + fq + " SET " + setClause + " WHERE " + whereClause;
            try (PreparedStatement ps = con.prepareStatement(sql)) {
                int i = 1;
                for (String c : setCols) ps.setObject(i++, coerce(set.get(c), sqlTypeOf(m, c)));
                for (String c : keyCols) ps.setObject(i++, coerce(key.get(c), sqlTypeOf(m, c)));
                return ps.executeUpdate();
            }
        });
    }

    public int deleteRow(String datasourceId, String schema, String table, Map<String, Object> key) {
        if (key == null || key.isEmpty()) throw new BadRequestException("A key (row identifier) is required to delete");
        return db.withConnection(datasourceId, false, (con) -> {
            TableMeta m = describe(con, datasourceId, schema, table);
            List<String> keyCols = validColumns(m, key.keySet());
            String fq = qualify(m.schema(), m.name());
            String whereClause = String.join(" AND ", keyCols.stream().map(c -> quote(c) + " = ?").toList());
            String sql = "DELETE FROM " + fq + " WHERE " + whereClause;
            try (PreparedStatement ps = con.prepareStatement(sql)) {
                int i = 1;
                for (String c : keyCols) ps.setObject(i++, coerce(key.get(c), sqlTypeOf(m, c)));
                return ps.executeUpdate();
            }
        });
    }

    // ---- ad-hoc SQL editor -------------------------------------------------

    /** Single-statement SQL. SELECT/WITH returns rows; INSERT/UPDATE/DELETE/MERGE returns affected. */
    public ExecResult execute(String datasourceId, String sql) {
        String kind = classify(sql);
        boolean readOnly = "select".equals(kind);
        return db.withConnection(datasourceId, readOnly, (con) -> {
            try (PreparedStatement ps = con.prepareStatement(sql)) {
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
    static String classify(String sql) {
        if (sql == null || sql.isBlank()) throw new BadRequestException("SQL is required");
        String t = sql.trim();
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
        throw new BadRequestException("Only SELECT / INSERT / UPDATE / DELETE / MERGE statements are allowed");
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
        return new Rows(cols, rows, rows.size());
    }

    private static Object norm(Object v) {
        if (v instanceof java.sql.Timestamp || v instanceof java.sql.Date || v instanceof java.sql.Time) {
            return String.valueOf(v);
        }
        if (v instanceof java.sql.Clob clob) {
            try { return clob.getSubString(1, (int) Math.min(clob.length(), 100_000)); }
            catch (Exception e) { return "[clob]"; }
        }
        if (v instanceof byte[]) return "[binary]";
        return v;
    }

    private static int sqlTypeOf(TableMeta m, String col) {
        return m.columns().stream().filter(ci -> ci.name().equals(col)).map(ColumnInfo::sqlType)
                .findFirst().orElse(Types.VARCHAR);
    }

    /**
     * The grid sends every cell as a String; coerce it to the column's JDBC type so strict drivers
     * (Postgres won't implicitly cast varchar→integer) accept the bind. Numbers/booleans are parsed;
     * everything else (text, dates as ISO strings) is passed through for the driver to handle.
     */
    private static Object coerce(Object v, int sqlType) {
        if (v == null || !(v instanceof String s)) return v;
        String t = s.trim();
        try {
            return switch (sqlType) {
                case Types.TINYINT, Types.SMALLINT, Types.INTEGER -> Integer.valueOf(t);
                case Types.BIGINT -> Long.valueOf(t);
                case Types.DECIMAL, Types.NUMERIC -> new java.math.BigDecimal(t);
                case Types.REAL, Types.FLOAT, Types.DOUBLE -> Double.valueOf(t);
                case Types.BIT, Types.BOOLEAN -> Boolean.valueOf(t);
                default -> s;
            };
        } catch (NumberFormatException e) {
            return s;   // let the database surface a clear type error for genuinely bad input
        }
    }

    /** Map requested keys to the table's real column names (case-insensitive), preserving order. */
    private static List<String> validColumns(TableMeta m, Set<String> requested) {
        List<String> out = new ArrayList<>();
        for (String want : requested) {
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
