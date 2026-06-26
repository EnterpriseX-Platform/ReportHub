package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.domain.EngineInstance;
import io.reporthub.reportstudio.dto.EngineDto;
import io.reporthub.reportstudio.dto.InstallEngineRequest;
import io.reporthub.reportstudio.engine.EngineDescriptor;
import io.reporthub.reportstudio.engine.EngineRegistry;
import io.reporthub.reportstudio.repo.EngineInstanceRepository;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/** Engine registry — install/configure engines (URL, JAR/lib, service) and list/test them. */
@RestController
@RequestMapping("/engines")
public class EngineController {

    private final EngineInstanceRepository repo;
    private final EngineRegistry registry;
    private final io.reporthub.reportstudio.engine.PluginEngineLoader plugins;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();

    public EngineController(EngineInstanceRepository repo, EngineRegistry registry,
                           io.reporthub.reportstudio.engine.PluginEngineLoader plugins) {
        this.repo = repo;
        this.registry = registry;
        this.plugins = plugins;
    }

    public record EngineListResponse(List<EngineDto> installed, List<String> availableKinds,
                                     List<EngineDescriptor> descriptors) {}
    public record TestResult(boolean ok, int status, long latencyMs, String message) {}
    public record PluginUpload(String fileName, String contentBase64, String encoding) {}
    public record PluginInstallResult(String jar, List<String> jars, List<String> availableKinds) {}

    /** Installed plugin JAR names. */
    @GetMapping("/plugins")
    public List<String> plugins() {
        return plugins.listJars();
    }

    /**
     * Upload a plugin JAR (a third-party {@link io.reporthub.reportstudio.engine.ReportEngine} via
     * ServiceLoader), persist it, and hot-reload the registry. ADMIN-only — a plugin is arbitrary
     * in-process code. The JAR travels base64 in JSON (same WAF reason as the other uploads).
     */
    @PostMapping("/plugins")
    @ResponseStatus(HttpStatus.CREATED)
    public PluginInstallResult installPlugin(@RequestBody PluginUpload body) {
        if (!plugins.isEnabled()) {
            throw new BadRequestException("Plugin loading is disabled (app.plugins.enabled=false)");
        }
        if (body == null || body.fileName() == null || body.fileName().isBlank()) {
            throw new BadRequestException("fileName is required");
        }
        if (body.contentBase64() == null || body.contentBase64().isBlank()) {
            throw new BadRequestException("File is empty");
        }
        byte[] jar = UnitController.decodeUploadContent(body.contentBase64(), body.encoding());
        String name;
        try {
            name = plugins.store(body.fileName(), jar);
        } catch (IllegalArgumentException e) {
            throw new BadRequestException(e.getMessage());
        }
        registry.reloadPlugins();
        return new PluginInstallResult(name, plugins.listJars(), registry.availableKinds());
    }

    @GetMapping
    public EngineListResponse list() {
        List<EngineDto> dbRows = repo.findAllByOrderByIdAsc().stream().map(EngineController::toDto).toList();
        Set<String> haveKinds = dbRows.stream().map(EngineDto::kind).collect(Collectors.toSet());
        List<EngineDescriptor> descriptors = registry.describe();
        // Surface built-in engines (requiresInstance=false, no DB row) as synthetic rows so the new
        // sql / api engines are visible on the Engines page without any per-engine seed/migration.
        // Negative ids keep them type-safe and out of the way of real DB ids; DB row wins per kind.
        List<EngineDto> merged = new ArrayList<>(dbRows);
        long synthId = -1;
        for (EngineDescriptor d : descriptors) {
            if (d.builtin() && !haveKinds.contains(d.kind())) {
                merged.add(new EngineDto(synthId--, d.label(), d.kind(), "builtin", null, null, null,
                        true, false, "Built-in engine — compiled into Report Studio, always available", null));
            }
        }
        return new EngineListResponse(merged, registry.availableKinds(), descriptors);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public EngineDto install(@Valid @RequestBody InstallEngineRequest req) {
        if (!registry.has(req.kind())) {
            throw new BadRequestException("No engine adapter loaded for kind '" + req.kind()
                    + "'. Available: " + registry.availableKinds());
        }
        EngineInstance e = new EngineInstance();
        apply(e, req);
        return toDto(repo.save(e));
    }

    @PutMapping("/{id}")
    @Transactional
    public EngineDto update(@PathVariable Long id, @Valid @RequestBody InstallEngineRequest req) {
        guardSynthetic(id);
        EngineInstance e = repo.findById(id).orElseThrow(() -> new NotFoundException("Engine not found: " + id));
        apply(e, req);
        return toDto(repo.save(e));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void remove(@PathVariable Long id) {
        guardSynthetic(id);
        EngineInstance e = repo.findById(id).orElseThrow(() -> new NotFoundException("Engine not found: " + id));
        if ("builtin".equals(e.getInstallMethod())) {
            throw new BadRequestException("Built-in engines cannot be removed");
        }
        repo.delete(e);
    }

    @PostMapping("/{id}/test")
    public TestResult test(@PathVariable Long id) {
        if (id != null && id < 0) {
            // Synthetic built-in row (negative id). An OLD frontend during a rolling deploy may still
            // render a Test button for it — answer cleanly instead of a confusing 404.
            return new TestResult(true, 200, 0, "Built-in engine is always available");
        }
        EngineInstance e = repo.findById(id).orElseThrow(() -> new NotFoundException("Engine not found: " + id));
        if ("builtin".equals(e.getInstallMethod())) {
            return new TestResult(true, 200, 0, "Built-in engine is always available");
        }
        if (e.getBaseUrl() == null || e.getBaseUrl().isBlank()) {
            return new TestResult(false, 0, 0, "No base URL configured");
        }
        long t0 = System.currentTimeMillis();
        try {
            HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(e.getBaseUrl()))
                    .timeout(Duration.ofSeconds(8)).GET();
            if (e.getAuthToken() != null && !e.getAuthToken().isBlank()) {
                rb.header("Authorization", "Bearer " + e.getAuthToken());
            }
            HttpResponse<Void> res = http.send(rb.build(), HttpResponse.BodyHandlers.discarding());
            long ms = System.currentTimeMillis() - t0;
            boolean ok = res.statusCode() < 500;
            return new TestResult(ok, res.statusCode(), ms, ok ? "Reachable" : "Server error");
        } catch (Exception ex) {
            return new TestResult(false, 0, System.currentTimeMillis() - t0, "Unreachable: " + ex.getMessage());
        }
    }

    /** Negative ids are synthetic built-in rows (see {@link #list()}), not real DB instances. */
    private static void guardSynthetic(Long id) {
        if (id != null && id < 0) {
            throw new BadRequestException("Built-in engines are always available and cannot be modified or removed");
        }
    }

    private static void apply(EngineInstance e, InstallEngineRequest req) {
        e.setName(req.name());
        e.setKind(req.kind());
        e.setInstallMethod(req.installMethod() == null ? "url" : req.installMethod());
        e.setBaseUrl(blankToNull(req.baseUrl()));
        if (req.authToken() != null && !req.authToken().isBlank()) {
            e.setAuthToken(req.authToken());
        }
        e.setComponentFormat(blankToNull(req.componentFormat()));
        e.setArtifactRef(blankToNull(req.artifactRef()));
        e.setNote(blankToNull(req.note()));
        e.setEnabled(req.enabled() == null || req.enabled());
    }

    private static EngineDto toDto(EngineInstance e) {
        return new EngineDto(e.getId(), e.getName(), e.getKind(), e.getInstallMethod(), e.getBaseUrl(),
                e.getComponentFormat(), e.getArtifactRef(), e.isEnabled(),
                e.getAuthToken() != null && !e.getAuthToken().isBlank(), e.getNote(), e.getCreatedAt());
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }
}
