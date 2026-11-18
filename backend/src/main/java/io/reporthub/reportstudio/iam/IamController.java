package io.reporthub.reportstudio.iam;

import io.reporthub.reportstudio.web.BadRequestException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** IAM connection settings, object-code export and the endpoint → object map. */
@RestController
public class IamController {

    public record IamSettingsBody(String baseUrl) {}

    private final IamSettings settings;
    private final IamPrincipalService principals;
    private final AuthMode mode;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.integration.ConnectorStore connectors;

    public IamController(IamSettings settings, IamPrincipalService principals, AuthMode mode) {
        this.settings = settings;
        this.principals = principals;
        this.mode = mode;
    }

    @GetMapping("/settings/iam")
    public Map<String, Object> get() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("authMode", mode.value());
        m.put("baseUrl", settings.baseUrl());
        m.put("cacheTtlSeconds", settings.cacheTtlSeconds());
        return m;
    }

    @PutMapping("/settings/iam")
    public Map<String, Object> put(@RequestBody IamSettingsBody b) {
        String url = b.baseUrl() == null ? "" : b.baseUrl().trim();
        if (!url.isEmpty() && !url.matches("https?://[^\\s]+")) throw new BadRequestException("Base URL must start with http:// or https://");
        // Kept for older clients; the IAM connector on Integrations → Identity is the place for this now.
        if (connectors == null) throw new BadRequestException("Integrations are not available");
        java.util.Map<String, Object> cfg = new java.util.LinkedHashMap<>(connectors.find("iam")
                .map(io.reporthub.reportstudio.integration.ConnectorStore.Row::config).orElse(java.util.Map.of()));
        cfg.put("baseUrl", url.replaceAll("/+$", ""));
        connectors.upsert("iam", "iam", "IAM", cfg, true, CurrentPrincipal.get().map(RhPrincipal::username).orElse(null));
        principals.clear();
        return get();
    }

    /**
     * Probe IAM. Body {@code {"baseUrl": "..."}} tests that URL without saving it; no body = the
     * saved URL. ok=true only for a 2xx from {@code /api/health}.
     */
    @PostMapping("/settings/iam/test")
    public Map<String, Object> test(@RequestBody(required = false) IamSettingsBody b) {
        RhPrincipal caller = CurrentPrincipal.get().orElse(null);
        if (caller == null || !caller.admin())
            throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.FORBIDDEN, "ReportHub admins only");
        try {
            String url = b != null && b.baseUrl() != null && !b.baseUrl().isBlank() ? b.baseUrl().trim() : settings.baseUrl();
            return principals.client().health(url);
        } catch (IamException e) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("ok", false);
            m.put("status", e.status());
            m.put("message", e.status() == 0 ? unreachable(e) : e.getMessage());
            m.put("baseUrl", settings.baseUrl());
            return m;
        }
    }

    private static String unreachable(IamException e) { return IamClient.unreachableMessage(e); }

    /** Object codes for import into the IAM service (application → module → objects). */
    @GetMapping(value = "/iam/objects/export", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> export(@RequestParam(defaultValue = "RH") String appCode) {
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"reporthub-iam-objects.json\"")
                .body(ObjectCatalog.exportDocument(appCode));
    }

    /** Which object/action each endpoint needs (documentation aid for admins). */
    @GetMapping("/iam/endpoints")
    public List<Map<String, Object>> endpoints() {
        return EndpointPolicy.rules().stream().map(r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("methods", r.methods().isEmpty() ? List.of("*") : r.methods());
            m.put("path", r.pattern());
            m.put("requires", r.anyOf().stream().map(q -> q.code() + ":" + q.action()).toList());
            return m;
        }).toList();
    }
}
