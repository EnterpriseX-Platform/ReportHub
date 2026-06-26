package io.reporthub.reportstudio.engine;

import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;

/**
 * Service Provider Interface for a report-generation engine.
 *
 * <p>This is the extension point that makes Report Studio engine-agnostic: the core resolves an
 * engine then asks it to render. Engines can be:
 * <ul>
 *   <li><b>built-in</b> Spring beans (e.g. Jasper) — light, in-process;</li>
 *   <li><b>remote</b> HTTP services (e.g. the OneWeb "component" engine) configured via a URL +
 *       credentials in {@link EngineConfig};</li>
 *   <li><b>plugins</b> dropped in as JARs and discovered through {@link java.util.ServiceLoader}.</li>
 * </ul>
 *
 * <p>Heavy rendering back-ends (Aspose, LibreOffice) live behind their OWN engine implementations in
 * separate modules/services so the core build stays fast — they are never compiled into core.
 */
public interface ReportEngine {

    /** Engine kind key matched against {@code EngineInstance.kind} (e.g. {@code jasper}, {@code component}, {@code http}). */
    String kind();

    /**
     * Render a report.
     *
     * @param req the report-specific ("custom") request — code, params, format, optional SQL
     * @param cfg the installed-engine configuration (base URL, auth, …); {@code null} for built-ins
     */
    RenderResult render(RenderRequest req, EngineConfig cfg);

    /**
     * Whether this engine needs an enabled {@code EngineInstance} (remote URL / credentials) before
     * it can render. Remote engines (component / http) return {@code true}; local in-process engines
     * (jasper / sql query-export) run with no install and return {@code false} (the default).
     */
    default boolean requiresInstance() {
        return false;
    }

    /** Human-friendly name shown in the UI. Defaults to {@link #kind()}. */
    default String label() {
        return kind();
    }

    /**
     * Install-time configuration fields (URL, credentials, …) the admin fills when registering an
     * instance of this engine on the Engines page. Empty for engines that need no install.
     */
    default java.util.List<EngineProp> instanceProps() {
        return java.util.List.of();
    }

    /**
     * Per-report configuration fields stored in the render unit's configJson (e.g. the SQL statement
     * for the query-export engine, the endpoint for the api engine). These drive the report config
     * form so selecting an engine determines how a report is set up. Empty for template-driven
     * engines (Jasper) that configure via uploaded files instead.
     */
    default java.util.List<EngineProp> reportProps() {
        return java.util.List.of();
    }
}
