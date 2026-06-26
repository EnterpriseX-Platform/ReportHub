package io.reporthub.reportstudio.engine;

import java.util.Map;

/**
 * Runtime configuration handed to an engine for one render. Built-in template engines ignore it;
 * remote (HTTP) engines use {@code baseUrl} + {@code authToken}; engines that need to read the
 * report's datasource themselves (e.g. a dropped-in JAR plugin, which gets no Spring injection and
 * so cannot resolve a {@code datasourceId} on its own) read the resolved {@code dsJdbcUrl} /
 * {@code dsUser} / {@code dsPassword}. Credentials come from the {@code datasource} table at render
 * time — never hard-coded.
 */
public record EngineConfig(
        String baseUrl,
        String authToken,
        String componentFormat,
        Map<String, String> props,
        String dsJdbcUrl,
        String dsUser,
        String dsPassword
) {
    public static final EngineConfig NONE = new EngineConfig(null, null, null, Map.of(), null, null, null);

    /** Backward-compatible constructor for callers that don't supply datasource details. */
    public EngineConfig(String baseUrl, String authToken, String componentFormat, Map<String, String> props) {
        this(baseUrl, authToken, componentFormat, props, null, null, null);
    }

    /** Return a copy with the report's resolved datasource connection details attached. */
    public EngineConfig withDatasource(String dsJdbcUrl, String dsUser, String dsPassword) {
        return new EngineConfig(baseUrl, authToken, componentFormat, props, dsJdbcUrl, dsUser, dsPassword);
    }
}
