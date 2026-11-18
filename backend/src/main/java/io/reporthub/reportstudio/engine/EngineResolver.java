package io.reporthub.reportstudio.engine;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.EngineInstance;
import io.reporthub.reportstudio.engine.builtin.JasperReportEngine;
import io.reporthub.reportstudio.render.RenderException;
import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;
import io.reporthub.reportstudio.repo.EngineInstanceRepository;

import java.util.Map;
import java.util.Optional;

/**
 * Resolves which engine renders a report, THEN renders the report-specific ("custom") request —
 * the two are deliberately separate so reports can be added/customised without touching the engine.
 *
 * <p>Routing: a report whose {@code engine} maps to a loaded engine that {@code requiresInstance()}
 * (remote engines like {@code component} / {@code http}) goes to that engine with its configured
 * URL/credentials from an enabled {@code EngineInstance}. Loaded LOCAL engines (jasper, sql
 * query-export) render in-process with no install. Unknown kinds (composite / api / csv) fall back
 * to the built-in Jasper engine.
 */
@Service
public class EngineResolver {

    private final EngineRegistry registry;
    private final EngineInstanceRepository instances;
    private final com.fasterxml.jackson.databind.ObjectMapper jsonMapper;
    private final io.reporthub.reportstudio.repo.DatasourceRepository datasources;

    public EngineResolver(EngineRegistry registry, EngineInstanceRepository instances,
                          com.fasterxml.jackson.databind.ObjectMapper jsonMapper,
                          io.reporthub.reportstudio.repo.DatasourceRepository datasources) {
        this.registry = registry;
        this.instances = instances;
        this.jsonMapper = jsonMapper;
        this.datasources = datasources;
    }

    @Transactional(readOnly = true)
    public RenderResult render(RenderRequest req) {
        String kind = (req.engine() == null || req.engine().isBlank()) ? JasperReportEngine.KIND : req.engine();

        ReportEngine engine = registry.engineForKind(kind).orElse(null);
        if (engine != null) {
            // Remote engines must be backed by an enabled installed instance (URL / credentials).
            EngineConfig cfg = engine.requiresInstance()
                    ? toConfig(instances.findFirstByKindAndEnabledTrue(kind)
                            .orElseThrow(() -> new RenderException("Engine '" + kind + "' is not installed/enabled")))
                    : EngineConfig.NONE;
            // Attach the report's resolved datasource so engines that get no Spring injection (JAR
            // plugins) can open their own connection from cfg.dsJdbcUrl()/dsUser()/dsPassword().
            return engine.render(req, withDatasource(cfg, req.datasourceId()));
        }

        // Unknown kind (composite / api / csv) falls back to the built-in Jasper engine in-process.
        ReportEngine local = registry.engineForKind(JasperReportEngine.KIND)
                .orElseThrow(() -> new RenderException("Built-in Jasper engine missing"));
        return local.render(req, withDatasource(EngineConfig.NONE, req.datasourceId()));
    }

    private EngineConfig toConfig(EngineInstance inst) {
        // INSTANCE_PROPS fields (e.g. the component engine's "app") are stored as JSON in the note
        // column. Parse them into props so cfg.props().get("app") actually resolves (previously note
        // was only ever exposed under the literal key "note", so app was always empty).
        Map<String, String> props = new java.util.HashMap<>();
        String note = inst.getNote();
        if (note != null && !note.isBlank()) {
            props.put("note", note);
            String trimmed = note.trim();
            if (trimmed.startsWith("{")) {
                try {
                    var node = jsonMapper.readTree(trimmed);
                    node.fields().forEachRemaining(e -> {
                        if (e.getValue() != null && e.getValue().isValueNode()) {
                            props.put(e.getKey(), e.getValue().asText());
                        }
                    });
                } catch (Exception ignore) {
                    // note is plain text, not JSON props — leave it under "note" only
                }
            }
        }
        return new EngineConfig(inst.getBaseUrl(), inst.getAuthToken(), inst.getComponentFormat(), props);
    }

    /**
     * Resolve a report's {@code datasourceId} to its connection details and attach them to the config,
     * so an engine that cannot inject Spring (a dropped-in JAR plugin) can still open its own JDBC
     * connection. Built-in engines ignore these fields. No-op when the report has no datasource.
     */
    private EngineConfig withDatasource(EngineConfig base, String datasourceId) {
        if (datasourceId == null || datasourceId.isBlank()) return base;
        return datasources.findById(datasourceId)
                .map(ds -> base.withDatasource(ds.getJdbcUrl(), ds.getDbUser(), ds.getDbPassword()))
                .orElse(base);
    }

    public Optional<EngineInstance> installedFor(String kind) {
        return instances.findFirstByKindAndEnabledTrue(kind);
    }
}
