package io.reporthub.reportstudio.engine.builtin;

import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.engine.EngineConfig;
import io.reporthub.reportstudio.engine.EngineProp;
import io.reporthub.reportstudio.engine.ReportEngine;
import io.reporthub.reportstudio.render.RenderException;
import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;

import java.util.List;

/**
 * Built-in <b>"Other"</b> source kind — information-only. It attaches no template/file; instead the
 * register/config form shows a single free-text area where the user records app-module notes, stored
 * in the render unit's {@code configJson} under {@code appModule}. A report using this engine exists
 * to DOCUMENT an external app module, not to produce output, so it is intentionally NOT runnable:
 * {@link #render} refuses to run (the UI shows the information only).
 *
 * <p>Local engine: {@link #requiresInstance()} is {@code false} — no remote install needed.</p>
 */
@Component
public class OtherEngine implements ReportEngine {

    public static final String KIND = "other";

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public String label() {
        return "Other (information only)";
    }

    @Override
    public List<EngineProp> reportProps() {
        return List.of(EngineProp.report(
                "appModule", "App module / information", "textarea", false,
                "Specify the app module or related info"));
    }

    @Override
    public RenderResult render(RenderRequest req, EngineConfig cfg) {
        throw new RenderException("Engine 'other' is information-only and does not produce a report.");
    }
}
