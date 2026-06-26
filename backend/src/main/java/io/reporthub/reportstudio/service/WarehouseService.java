package io.reporthub.reportstudio.service;

import org.springframework.scheduling.support.CronExpression;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.WarehousePipeline;
import io.reporthub.reportstudio.domain.WarehouseRun;
import io.reporthub.reportstudio.repo.WarehousePipelineRepository;
import io.reporthub.reportstudio.repo.WarehouseRunRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Types;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Data-warehouse ETL (the "pull data from a real source into a target table" feature): run a source SELECT against any
 * datasource and load the rows into a target table on any datasource. Target is auto-created from
 * the result-set metadata when missing. Load modes: replace (truncate+insert), append (insert),
 * upsert (delete-by-key then insert — "clear by key"). Rows are streamed and batched so large
 * extracts don't buffer in memory; the whole load runs in one target-side transaction.
 */
@Service
public class WarehouseService {

    private static final Pattern IDENT = Pattern.compile("[A-Za-z_][A-Za-z0-9_$#]*");
    private static final int BATCH = 1000;

    public record LoadStats(int rowsRead, int rowsWritten, boolean created) {}

    private final WarehousePipelineRepository repo;
    private final WarehouseRunRepository runs;
    private final DbConnections db;

    public WarehouseService(WarehousePipelineRepository repo, WarehouseRunRepository runs, DbConnections db) {
        this.repo = repo;
        this.runs = runs;
        this.db = db;
    }

    @Transactional(readOnly = true)
    public List<WarehousePipeline> list() {
        return repo.findAllByOrderByCreatedAtDesc();
    }

    @Transactional(readOnly = true)
    public WarehousePipeline require(Long id) {
        return repo.findById(id).orElseThrow(() -> new NotFoundException("Pipeline not found: " + id));
    }

    @Transactional(readOnly = true)
    public List<WarehouseRun> history(Long id, int limit) {
        require(id);
        return runs.findByPipelineIdOrderByStartedAtDesc(id,
                org.springframework.data.domain.PageRequest.of(0, Math.min(Math.max(limit, 1), 200)));
    }

    @Transactional
    public WarehousePipeline save(Long id, WarehousePipeline form, String user) {
        validate(form);
        WarehousePipeline p = id == null ? new WarehousePipeline() : require(id);
        p.setName(form.getName().trim());
        p.setDescription(form.getDescription());
        p.setSourceDatasourceId(blank(form.getSourceDatasourceId()));
        p.setSourceSql(form.getSourceSql().trim());
        p.setTargetDatasourceId(blank(form.getTargetDatasourceId()));
        p.setTargetTable(form.getTargetTable().trim());
        p.setLoadMode(form.getLoadMode());
        p.setKeyColumns(blank(form.getKeyColumns()));
        p.setAutoCreate(form.isAutoCreate());
        p.setCron(blank(form.getCron()));
        p.setEnabled(form.isEnabled());
        OffsetDateTime now = OffsetDateTime.now();
        if (id == null) { p.setCreatedBy(user); p.setCreatedAt(now); }
        p.setUpdatedAt(now);
        p.setNextRunAt(p.isEnabled() && p.getCron() != null ? nextFrom(p.getCron(), now) : null);
        return repo.save(p);
    }

    @Transactional
    public WarehousePipeline setEnabled(Long id, boolean enabled) {
        WarehousePipeline p = require(id);
        p.setEnabled(enabled);
        p.setUpdatedAt(OffsetDateTime.now());
        p.setNextRunAt(enabled && p.getCron() != null ? nextFrom(p.getCron(), OffsetDateTime.now()) : null);
        return repo.save(p);
    }

    @Transactional
    public void delete(Long id) {
        WarehousePipeline p = require(id);
        runs.deleteByPipelineId(id);
        repo.delete(p);
    }

    @Transactional
    public WarehouseRun runNow(Long id, String user) {
        return execute(require(id), "manual", user);
    }

    @Transactional
    public int runDue() {
        OffsetDateTime now = OffsetDateTime.now();
        List<WarehousePipeline> due = repo.findByEnabledTrueAndCronIsNotNullAndNextRunAtLessThanEqual(now);
        for (WarehousePipeline p : due) {
            p.setNextRunAt(nextFrom(p.getCron(), now));   // advance first so a slow run can't double-fire
            repo.save(p);
            execute(p, "scheduled", "scheduler");
        }
        return due.size();
    }

    // ---- the load ----------------------------------------------------------

    private WarehouseRun execute(WarehousePipeline p, String trigger, String user) {
        WarehouseRun run = new WarehouseRun();
        run.setPipelineId(p.getId());
        run.setStartedAt(OffsetDateTime.now());
        run.setTrigger(trigger);
        run.setRunBy(user);
        try {
            LoadStats st = load(p);
            run.setStatus("ok");
            run.setRowsRead(st.rowsRead());
            run.setRowsWritten(st.rowsWritten());
            run.setMessage((st.created() ? "created target · " : "") + st.rowsRead()
                    + " read · " + st.rowsWritten() + " written");
            p.setLastStatus("ok");
            p.setLastError(null);
            p.setLastRowsRead(st.rowsRead());
            p.setLastRowsWritten(st.rowsWritten());
        } catch (Exception e) {
            run.setStatus("error");
            run.setMessage(trunc(rootMessage(e)));
            p.setLastStatus("error");
            p.setLastError(trunc(rootMessage(e)));
        }
        run.setFinishedAt(OffsetDateTime.now());
        p.setLastRunAt(run.getStartedAt());
        repo.save(p);
        return runs.save(run);
    }

    private LoadStats load(WarehousePipeline p) throws Exception {
        DatasetService.validateSql(p.getSourceSql());     // SELECT-only guard
        String mode = p.getLoadMode();
        List<String> keyCols = "upsert".equals(mode) ? csv(p.getKeyColumns()) : List.of();
        if ("upsert".equals(mode) && keyCols.isEmpty()) {
            throw new BadRequestException("Upsert needs at least one key column");
        }
        boolean targetOracle = db.isOracle(p.getTargetDatasourceId());

        try (Connection src = db.open(p.getSourceDatasourceId(), true);
             Connection tgt = db.open(p.getTargetDatasourceId(), false)) {
            src.setAutoCommit(false);                       // lets Postgres stream instead of buffering
            try (PreparedStatement sps = src.prepareStatement(p.getSourceSql())) {
                sps.setFetchSize(BATCH);
                try (ResultSet rs = sps.executeQuery()) {
                    ResultSetMetaData md = rs.getMetaData();
                    List<String> cols = new ArrayList<>();
                    for (int i = 1; i <= md.getColumnCount(); i++) cols.add(md.getColumnLabel(i));
                    cols.forEach(WarehouseService::checkIdent);
                    keyCols.forEach(k -> {
                        if (cols.stream().noneMatch(c -> c.equalsIgnoreCase(k)))
                            throw new BadRequestException("Key column not in the source result: " + k);
                    });

                    String schema = targetSchema(tgt, p.getTargetDatasourceId());
                    boolean exists = tableExists(tgt, schema, p.getTargetTable());
                    boolean created = false;
                    if (!exists) {
                        if (!p.isAutoCreate()) {
                            throw new BadRequestException("Target table '" + p.getTargetTable()
                                    + "' does not exist (enable Auto-create to build it from the query result)");
                        }
                        createTable(tgt, schema, p.getTargetTable(), cols, md, targetOracle);
                        created = true;
                    }

                    tgt.setAutoCommit(false);
                    try {
                        if ("replace".equals(mode) && !created) clearTable(tgt, schema, p.getTargetTable());
                        LoadStats s = stream(rs, tgt, schema, p.getTargetTable(), cols, keyCols, mode);
                        tgt.commit();
                        return new LoadStats(s.rowsRead(), s.rowsWritten(), created);
                    } catch (Exception e) {
                        try { tgt.rollback(); } catch (Exception ignored) { /* best effort */ }
                        throw e;
                    }
                }
            }
        }
    }

    private LoadStats stream(ResultSet rs, Connection tgt, String schema, String table,
                             List<String> cols, List<String> keyCols, String mode) throws Exception {
        String fq = qualify(schema, table);
        String colList = String.join(", ", cols.stream().map(WarehouseService::quote).toList());
        String binds = String.join(", ", cols.stream().map(c -> "?").toList());
        String insertSql = "INSERT INTO " + fq + " (" + colList + ") VALUES (" + binds + ")";
        String deleteSql = keyCols.isEmpty() ? null : "DELETE FROM " + fq + " WHERE "
                + String.join(" AND ", keyCols.stream().map(c -> quote(realCol(cols, c)) + " = ?").toList());

        int read = 0, written = 0, batch = 0;
        try (PreparedStatement ins = tgt.prepareStatement(insertSql);
             PreparedStatement del = deleteSql == null ? null : tgt.prepareStatement(deleteSql)) {
            while (rs.next()) {
                read++;
                if (del != null) {                          // upsert: clear the existing keyed row first
                    int k = 1;
                    for (String key : keyCols) del.setObject(k++, rs.getObject(realCol(cols, key)));
                    del.executeUpdate();
                }
                for (int i = 1; i <= cols.size(); i++) ins.setObject(i, rs.getObject(i));
                ins.addBatch();
                written++;
                if (++batch >= BATCH) { ins.executeBatch(); batch = 0; }
            }
            if (batch > 0) ins.executeBatch();
        }
        return new LoadStats(read, written, false);
    }

    // ---- DDL / metadata ----------------------------------------------------

    private boolean tableExists(Connection con, String schema, String table) throws Exception {
        try (ResultSet rs = con.getMetaData().getTables(con.getCatalog(), schema, table,
                new String[]{"TABLE"})) {
            while (rs.next()) {
                if (table.equalsIgnoreCase(rs.getString("TABLE_NAME"))) return true;
            }
        }
        return false;
    }

    private void createTable(Connection con, String schema, String table, List<String> cols,
                             ResultSetMetaData md, boolean oracle) throws Exception {
        StringBuilder ddl = new StringBuilder("CREATE TABLE ").append(qualify(schema, table)).append(" (");
        for (int i = 1; i <= cols.size(); i++) {
            if (i > 1) ddl.append(", ");
            ddl.append(quote(cols.get(i - 1))).append(' ')
               .append(ddlType(md.getColumnType(i), md.getPrecision(i), md.getScale(i), oracle));
        }
        ddl.append(')');
        try (java.sql.Statement st = con.createStatement()) { st.execute(ddl.toString()); }
    }

    private void clearTable(Connection con, String schema, String table) throws Exception {
        // DELETE (not TRUNCATE) so it participates in the surrounding transaction and respects perms.
        try (java.sql.Statement st = con.createStatement()) {
            st.executeUpdate("DELETE FROM " + qualify(schema, table));
        }
    }

    private static String ddlType(int sqlType, int precision, int scale, boolean oracle) {
        return switch (sqlType) {
            case Types.TINYINT, Types.SMALLINT, Types.INTEGER -> oracle ? "NUMBER(10)" : "INTEGER";
            case Types.BIGINT -> oracle ? "NUMBER(19)" : "BIGINT";
            case Types.DECIMAL, Types.NUMERIC -> oracle ? "NUMBER"
                    : (precision > 0 && precision <= 1000
                        ? "NUMERIC(" + precision + "," + Math.max(scale, 0) + ")" : "NUMERIC");
            case Types.REAL, Types.FLOAT, Types.DOUBLE -> oracle ? "BINARY_DOUBLE" : "DOUBLE PRECISION";
            case Types.BIT, Types.BOOLEAN -> oracle ? "NUMBER(1)" : "BOOLEAN";
            case Types.DATE -> oracle ? "DATE" : "DATE";
            case Types.TIME -> oracle ? "DATE" : "TIME";
            case Types.TIMESTAMP, Types.TIMESTAMP_WITH_TIMEZONE -> "TIMESTAMP";
            default -> oracle ? "VARCHAR2(4000)" : "TEXT";
        };
    }

    private static String targetSchema(Connection con, String datasourceId) throws Exception {
        if (datasourceId == null || datasourceId.isBlank()) return null;        // internal Postgres → public
        if (!con.getMetaData().getURL().startsWith("jdbc:oracle")) return null;
        String s = con.getSchema();
        return (s == null || s.isBlank()) ? con.getMetaData().getUserName() : s;
    }

    // ---- validation / helpers ----------------------------------------------

    private static void validate(WarehousePipeline f) {
        if (f.getName() == null || f.getName().isBlank()) throw new BadRequestException("Name is required");
        if (f.getSourceSql() == null || f.getSourceSql().isBlank()) throw new BadRequestException("Source SQL is required");
        DatasetService.validateSql(f.getSourceSql());
        if (f.getTargetTable() == null || !IDENT.matcher(f.getTargetTable().trim()).matches()) {
            throw new BadRequestException("Target table must be a simple identifier (letters, digits, underscore)");
        }
        String mode = f.getLoadMode();
        if (!List.of("replace", "append", "upsert").contains(mode)) {
            throw new BadRequestException("Load mode must be replace, append or upsert");
        }
        if ("upsert".equals(mode) && csv(f.getKeyColumns()).isEmpty()) {
            throw new BadRequestException("Upsert needs at least one key column");
        }
        if (f.getCron() != null && !f.getCron().isBlank()) {
            try { CronExpression.parse(f.getCron().trim()); }
            catch (IllegalArgumentException e) { throw new BadRequestException("Invalid cron: " + e.getMessage()); }
        }
    }

    private static List<String> csv(String s) {
        if (s == null || s.isBlank()) return List.of();
        Set<String> out = new LinkedHashSet<>();
        for (String part : s.split(",")) { String t = part.trim(); if (!t.isEmpty()) out.add(t); }
        return new ArrayList<>(out);
    }

    /** Resolve a key name to the source column's actual label (case-insensitive). */
    private static String realCol(List<String> cols, String want) {
        return cols.stream().filter(c -> c.equalsIgnoreCase(want)).findFirst().orElse(want);
    }

    private static void checkIdent(String ident) {
        if (ident == null || !IDENT.matcher(ident).matches()) {
            throw new BadRequestException("Result column name is not a valid identifier: '" + ident
                    + "' — alias it in the SELECT (e.g. AS my_col)");
        }
    }

    private static String qualify(String schema, String table) {
        return (schema == null || schema.isBlank() ? "" : quote(schema) + ".") + quote(table);
    }

    private static String quote(String ident) {
        if (ident == null || ident.contains("\"")) throw new BadRequestException("Invalid identifier: " + ident);
        return "\"" + ident + "\"";
    }

    private static OffsetDateTime nextFrom(String cron, OffsetDateTime from) {
        ZonedDateTime next = CronExpression.parse(cron.trim()).next(from.toZonedDateTime());
        return next == null ? null : next.toOffsetDateTime();
    }

    private static String rootMessage(Throwable e) {
        Throwable c = e;
        while (c.getCause() != null && c.getCause() != c) c = c.getCause();
        return c.getMessage() == null ? e.toString() : c.getMessage();
    }

    private static String blank(String s) { return (s == null || s.isBlank()) ? null : s.trim(); }

    private static String trunc(String s) {
        if (s == null) return null;
        return s.length() > 4000 ? s.substring(0, 4000) : s;
    }
}
