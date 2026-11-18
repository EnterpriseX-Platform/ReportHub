package io.reporthub.reportstudio.service.etl;

import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.service.DbConnections;
import io.reporthub.reportstudio.service.RepositoryService;
import io.reporthub.reportstudio.service.WarehouseService;
import io.reporthub.reportstudio.web.BadRequestException;

import java.sql.PreparedStatement;
import java.util.Map;

/**
 * Runs a statement written into the step itself — INSERT/UPDATE/DELETE/MERGE, or a PL/SQL block.
 *
 * <p>config: {@code datasourceId}, {@code sql}.
 */
@Component
public class SqlStepExecutor implements ChainStepExecutor {

    private final DbConnections db;

    public SqlStepExecutor(DbConnections db) {
        this.db = db;
    }

    @Override public String type() { return "sql"; }
    @Override public String label() { return "Run SQL / PL-SQL"; }

    @Override
    public StepResult run(Map<String, Object> config, StepContext ctx) throws Exception {
        String raw = str(config, "sql");
        if (raw == null || raw.isBlank()) throw new BadRequestException("No SQL statement provided");
        String datasourceId = str(config, "datasourceId");

        String sql = WarehouseService.resolveYear(ctx.render(raw), ctx.year());
        String kind = RepositoryService.classify(sql);
        if ("select".equals(kind)) {
            throw new BadRequestException("This step is for statements that write data — use a data check step for read-only queries");
        }
        boolean block = "block".equals(kind);

        int affected = db.withConnection(datasourceId, false, (con) -> {
            try (PreparedStatement ps = con.prepareStatement(sql)) {
                // A PL/SQL block has no update count to report.
                if (block) { ps.execute(); return -1; }
                return ps.executeUpdate();
            }
        });

        String msg = block ? "PL/SQL block ran successfully" : String.format("%,d rows affected", affected);
        return StepResult.ok(msg, null, block ? null : affected,
                Map.of("affected", block ? 0 : affected));
    }

    static String str(Map<String, Object> config, String key) {
        Object v = config == null ? null : config.get(key);
        return v == null ? null : String.valueOf(v);
    }
}
