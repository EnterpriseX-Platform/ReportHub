package io.reporthub.reportstudio.engine.builtin;

import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.engine.EngineConfig;
import io.reporthub.reportstudio.engine.ReportEngine;
import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;
import io.reporthub.reportstudio.render.ReportRenderer;

/**
 * Built-in, in-process engine: local JasperReports (PDF) + POI (XLSX) + CSV, and SQL-over-Postgres.
 * Delegates to the existing {@link ReportRenderer}. Light — no Aspose/LibreOffice — so it never
 * slows the core build. This is the default engine when no remote instance matches.
 */
@Component
public class JasperReportEngine implements ReportEngine {

    public static final String KIND = "jasper";

    private final ReportRenderer renderer;

    public JasperReportEngine(ReportRenderer renderer) {
        this.renderer = renderer;
    }

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public String label() {
        return "Jasper";
    }

    @Override
    public RenderResult render(RenderRequest req, EngineConfig cfg) {
        return renderer.render(req);
    }
}
