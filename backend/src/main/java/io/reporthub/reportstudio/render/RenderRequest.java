package io.reporthub.reportstudio.render;

import java.util.Map;

/**
 * Immutable request describing what to render.
 *
 * @param code         report code (e.g. SALES-001), used for filenames/metadata
 * @param name       display name shown as the report title
 * @param engine       rendering engine hint: {@code jasper}, {@code composite}, or {@code sql}
 * @param format       output format: {@code pdf}, {@code xlsx}, or {@code csv} (case-insensitive)
 * @param params       arbitrary report parameters (never required; may be {@code null})
 * @param sqlStatement optional SQL to run against the primary Postgres datasource; when present the
 *                     result set supplies the rows instead of the bundled sample dataset
 * @param datasourceId optional datasource identifier (informational; the primary JdbcTemplate is used)
 * @param templateKey  optional object-storage key of an UPLOADED main template (render-unit file);
 *                     the Jasper engine compiles and fills it instead of the generic layout
 * @param subreports   optional uploaded Jasper subreports: parameter name -> object-storage key.
 *                     Each is compiled and exposed to the main template as a parameter of that name.
 * @param configJson   the render unit's raw config JSON ({@code {"sql":...}}, {@code {"endpoint":...}}, …);
 *                     engines read their declared reportProps from it (the api engine reads endpoint, etc.)
 * @param callerToken  SENSITIVE, in-process only — the edge-authenticated caller's Keycloak access token,
 *                     or null. Set only for an api-engine report that opts in via {@code forwardEdgeToken};
 *                     the engine forwards it as the outbound auth header so the fetch runs AS the user.
 *                     Never persisted, never logged.
 */
public record RenderRequest(
        String code,
        String name,
        String engine,
        String format,
        Map<String, Object> params,
        String sqlStatement,
        String datasourceId,
        String templateKey,
        Map<String, String> subreports,
        String configJson,
        String callerToken
) {
    /** Convenience constructor for the legacy single-render path (no uploaded template). */
    public RenderRequest(String code, String name, String engine, String format,
                         Map<String, Object> params, String sqlStatement, String datasourceId) {
        this(code, name, engine, format, params, sqlStatement, datasourceId, null, null, null);
    }

    /** Backward-compatible constructor without configJson. */
    public RenderRequest(String code, String name, String engine, String format,
                         Map<String, Object> params, String sqlStatement, String datasourceId,
                         String templateKey, Map<String, String> subreports) {
        this(code, name, engine, format, params, sqlStatement, datasourceId, templateKey, subreports, null);
    }

    /** Backward-compatible constructor without a caller token (the common no-edge-passthrough path). */
    public RenderRequest(String code, String name, String engine, String format,
                         Map<String, Object> params, String sqlStatement, String datasourceId,
                         String templateKey, Map<String, String> subreports, String configJson) {
        this(code, name, engine, format, params, sqlStatement, datasourceId, templateKey, subreports, configJson, null);
    }
}
