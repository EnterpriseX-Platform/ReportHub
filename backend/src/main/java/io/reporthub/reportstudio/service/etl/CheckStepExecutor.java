package io.reporthub.reportstudio.service.etl;

import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.service.DatasetService;
import io.reporthub.reportstudio.service.WarehouseService;
import io.reporthub.reportstudio.web.BadRequestException;

import java.util.Map;

/**
 * A gate written into the step: run a SELECT and fail the step when it returns more rows than the
 * step tolerates.
 *
 * <p>config: {@code datasourceId}, {@code sql}, {@code maxRows} (default 0).
 *
 * <p>Counting happens in the database. A check that finds 200,000 bad rows must not drag them back
 * to say so.
 */
@Component
public class CheckStepExecutor implements ChainStepExecutor {

    private final DatasetService datasets;

    public CheckStepExecutor(DatasetService datasets) {
        this.datasets = datasets;
    }

    @Override public String type() { return "assert"; }
    @Override public String label() { return "Assert (stop when it fails)"; }

    @Override
    public StepResult run(Map<String, Object> config, StepContext ctx) {
        String raw = SqlStepExecutor.str(config, "sql");
        if (raw == null || raw.isBlank()) throw new BadRequestException("No check query specified");
        int maxRows = intOf(config.get("maxRows"), 0);
        String sql = WarehouseService.resolveYear(ctx.render(raw), ctx.year());

        DatasetService.TableResult r = datasets.preview(SqlStepExecutor.str(config, "datasourceId"),
                "SELECT COUNT(*) AS BAD_ROWS FROM (" + sql + ") chk_q", 1);
        int count = firstInt(r);
        boolean pass = count <= maxRows;
        String msg = pass
                ? String.format("Passed: %,d rows found (allowed %,d)", count, maxRows)
                : String.format("Failed: %,d rows found, more than the allowed %,d", count, maxRows);
        return new StepResult(pass, msg, count, null, Map.of("count", count, "pass", pass));
    }

    private static int intOf(Object v, int dflt) {
        if (v instanceof Number n) return n.intValue();
        try { return v == null ? dflt : Integer.parseInt(String.valueOf(v).trim()); }
        catch (NumberFormatException e) { return dflt; }
    }

    private static int firstInt(DatasetService.TableResult r) {
        if (r.rows().isEmpty() || r.rows().get(0).isEmpty()) return 0;
        Object v = r.rows().get(0).get(0);
        return v instanceof Number n ? n.intValue() : Integer.parseInt(String.valueOf(v));
    }
}
