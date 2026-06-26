package io.reporthub.reportstudio.engine;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Holds every available {@link ReportEngine} — built-in Spring beans plus JAR/ServiceLoader plugins —
 * keyed by {@link ReportEngine#kind()}. The {@link EngineResolver} consults this to pick the engine
 * for a report; per-report "custom" details are resolved separately. Plugins can be (re)loaded at
 * runtime via {@link #reloadPlugins()} after a JAR is installed.
 */
@Service
public class EngineRegistry {

    private static final Logger log = LoggerFactory.getLogger(EngineRegistry.class);

    private final Map<String, ReportEngine> byKind = new ConcurrentHashMap<>();
    private final Set<String> builtinKinds;
    private final PluginEngineLoader pluginLoader;

    public EngineRegistry(List<ReportEngine> engines, PluginEngineLoader pluginLoader) {
        engines.forEach(e -> byKind.put(e.kind(), e));
        this.builtinKinds = Set.copyOf(byKind.keySet());
        this.pluginLoader = pluginLoader;
        // Never let a plugin problem stop the built-in engines (and the whole app) from starting.
        try {
            reloadPlugins();
        } catch (Exception e) {
            log.error("Plugin load at startup failed — built-in engines still available: {}", e.toString());
        }
    }

    /** Re-scan plugin JARs: drop previously-loaded plugin engines and register the current set. */
    public final synchronized void reloadPlugins() {
        if (pluginLoader == null || !pluginLoader.isEnabled()) return;
        byKind.keySet().removeIf(k -> !builtinKinds.contains(k));
        for (ReportEngine e : pluginLoader.load()) {
            if (e.kind() == null || e.kind().isBlank()) {
                log.warn("Plugin engine with a blank kind() ignored");
                continue;
            }
            if (builtinKinds.contains(e.kind())) {
                log.warn("Plugin engine kind '{}' clashes with a built-in engine — ignored", e.kind());
                continue;
            }
            byKind.put(e.kind(), e);
            log.info("Registered plugin engine: {} ({})", e.kind(), e.label());
        }
    }

    public Optional<ReportEngine> engineForKind(String kind) {
        return Optional.ofNullable(byKind.get(kind));
    }

    public boolean has(String kind) {
        return byKind.containsKey(kind);
    }

    /** Whether a kind is a compiled-in built-in (vs a runtime-loaded plugin). */
    public boolean isBuiltin(String kind) {
        return builtinKinds.contains(kind);
    }

    /** All engine kinds currently loaded into the process (built-in + plugins). */
    public List<String> availableKinds() {
        return byKind.keySet().stream().sorted().toList();
    }

    /**
     * Code-declared description of every loaded engine (kind, label, requires-instance, props),
     * the single source of truth that drives the Engines page and the engine-driven config forms.
     */
    public List<EngineDescriptor> describe() {
        return byKind.values().stream()
                .map(e -> new EngineDescriptor(
                        e.kind(), e.label(), e.requiresInstance(), !e.requiresInstance(),
                        e.instanceProps(), e.reportProps()))
                .sorted(java.util.Comparator.comparing(EngineDescriptor::kind))
                .toList();
    }
}
