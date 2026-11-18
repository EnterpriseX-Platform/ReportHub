package io.reporthub.reportstudio.service.etl;

import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.domain.WarehousePipeline;
import io.reporthub.reportstudio.service.WarehouseService;
import io.reporthub.reportstudio.web.BadRequestException;

import java.util.Map;

/**
 * SELECT from one place, write the rows into a table — the pipeline load, written into the step
 * instead of pointing at a saved pipeline.
 *
 * <p>config: {@code sourceDatasourceId}, {@code sourceSql}, {@code targetDatasourceId},
 * {@code targetSchema}, {@code targetTable}, {@code loadMode} (replace|append|upsert),
 * {@code keyColumns}, {@code autoCreate}, {@code addColumns}, {@code clearMode}.
 *
 * <p>The load itself is {@code WarehouseService}'s, not a second copy: batching, target creation,
 * type mapping and the Postgres streaming workaround all live there, and two implementations of
 * that would drift apart the first time one of them was fixed.
 */
@Component
public class LoadStepExecutor implements ChainStepExecutor {

    private final WarehouseService warehouse;

    public LoadStepExecutor(WarehouseService warehouse) {
        this.warehouse = warehouse;
    }

    @Override public String type() { return "load"; }
    @Override public String label() { return "Load into a table"; }

    @Override
    public StepResult run(Map<String, Object> config, StepContext ctx) throws Exception {
        String sql = SqlStepExecutor.str(config, "sourceSql");
        String table = SqlStepExecutor.str(config, "targetTable");
        if (sql == null || sql.isBlank()) throw new BadRequestException("Source SELECT statement is missing");
        if (table == null || table.isBlank()) throw new BadRequestException("Target table is not specified");

        WarehousePipeline p = new WarehousePipeline();
        p.setName("inline");
        p.setSourceDatasourceId(SqlStepExecutor.str(config, "sourceDatasourceId"));
        p.setSourceSql(ctx.render(sql));
        p.setTargetDatasourceId(SqlStepExecutor.str(config, "targetDatasourceId"));
        p.setTargetSchema(SqlStepExecutor.str(config, "targetSchema"));
        p.setTargetTable(table.trim());
        p.setLoadMode(orElse(SqlStepExecutor.str(config, "loadMode"), "replace"));
        p.setKeyColumns(SqlStepExecutor.str(config, "keyColumns"));
        p.setClearMode(orElse(SqlStepExecutor.str(config, "clearMode"), "delete"));
        // The slice this step owns — without it the load clears the whole table instead of only its own part
        // (several steps can share one target table and differ only in this value)
        p.setClearWhere(SqlStepExecutor.str(config, "clearWhere"));
        p.setAutoCreate(!"false".equalsIgnoreCase(SqlStepExecutor.str(config, "autoCreate")));
        p.setAddColumns("true".equalsIgnoreCase(SqlStepExecutor.str(config, "addColumns")));
        p.setControlColumn(SqlStepExecutor.str(config, "controlColumn"));
        String tol = SqlStepExecutor.str(config, "controlTolerance");
        if (tol != null && !tol.isBlank()) {
            try { p.setControlTolerance(new java.math.BigDecimal(tol.trim())); }
            catch (NumberFormatException ignore) { /* invalid value = no tolerance, which is stricter and safer */ }
        }

        WarehouseService.Loaded r = warehouse.loadAndReconcile(p, ctx.year());
        WarehouseService.LoadStats st = r.stats();
        // Totals not matching the source = step fails; a reconciliation error also fails — a check that
        // passes when it breaks is a check that is silently switched off
        boolean reconBad = r.recon() != null && !"match".equals(r.recon().status());
        String msg = (st.created() ? "Created target table · " : "")
                + String.format("Read %,d · wrote %,d rows", st.rowsRead(), st.rowsWritten())
                + (r.recon() == null ? "" : " · " + r.recon().message());
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("rowsRead", st.rowsRead());
        out.put("rowsWritten", st.rowsWritten());
        if (r.recon() != null) out.put("reconStatus", r.recon().status());
        return reconBad
                ? new StepResult(false, msg, st.rowsRead(), st.rowsWritten(), out)
                : StepResult.ok(msg, st.rowsRead(), st.rowsWritten(), out);
    }

    private static String orElse(String v, String dflt) {
        return v == null || v.isBlank() ? dflt : v.trim();
    }
}
