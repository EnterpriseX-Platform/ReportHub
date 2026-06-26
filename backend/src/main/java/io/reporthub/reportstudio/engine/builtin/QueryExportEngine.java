package io.reporthub.reportstudio.engine.builtin;

import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.engine.EngineConfig;
import io.reporthub.reportstudio.engine.ReportEngine;
import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;
import io.reporthub.reportstudio.render.ReportRenderer;

/**
 * Built-in, in-process <b>query-export</b> engine. Runs a report's own SQL (from the render unit's
 * {@code configJson {"sql":...}}) against its datasource and streams the result straight to
 * CSV / XLSX / PDF — deliberately NOT through Jasper, so it scales to result sets of millions of
 * rows (the BCE bulk-extract case). A distinct {@link ReportEngine} in the SDK so a report can pick
 * it by {@code engine = "sql"} without touching the Jasper engine.
 *
 * <p>Local engine: {@link #requiresInstance()} is {@code false}, so it needs no remote install.</p>
 */
@Component
public class QueryExportEngine implements ReportEngine {

    public static final String KIND = "sql";

    private final ReportRenderer renderer;

    public QueryExportEngine(ReportRenderer renderer) {
        this.renderer = renderer;
    }

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public String label() {
        return "SQL query-export";
    }

    @Override
    public java.util.List<io.reporthub.reportstudio.engine.EngineProp> reportProps() {
        return java.util.List.of(
                io.reporthub.reportstudio.engine.EngineProp.report(
                        "sql", "SQL statement", "sql", true, "SELECT * FROM v_report"));
    }

    @Override
    public RenderResult render(RenderRequest req, EngineConfig cfg) {
        return renderer.renderQuery(req);
    }
}
