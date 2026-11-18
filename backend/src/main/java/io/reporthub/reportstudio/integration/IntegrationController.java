package io.reporthub.reportstudio.integration;

import io.reporthub.reportstudio.document.DocumentExporterClient;
import io.reporthub.reportstudio.domain.Datasource;
import io.reporthub.reportstudio.iam.AuthMode;
import io.reporthub.reportstudio.iam.CurrentPrincipal;
import io.reporthub.reportstudio.iam.IamException;
import io.reporthub.reportstudio.iam.IamPrincipalService;
import io.reporthub.reportstudio.iam.IamSettings;
import io.reporthub.reportstudio.iam.RhPrincipal;
import io.reporthub.reportstudio.repo.DatasourceRepository;
import io.reporthub.reportstudio.storage.MinioProperties;
import io.reporthub.reportstudio.storage.ObjectStorageService;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.*;

/**
 * Integrations: every external system ReportHub talks to, grouped by category. Database connections
 * stay in {@code /datasources} (and their own table) and are listed here read-only; IAM, FileHub and
 * the notification service are rows of {@code connector}; object storage and the document exporter
 * come from the deployment config and are shown with a health check. Writes are ReportHub-admin only;
 * secrets are never returned.
 */
@RestController
public class IntegrationController {

    public record SaveBody(String id, String type, String name, Boolean enabled, Map<String, Object> config) {}
    public record TestBody(Map<String, Object> config) {}

    private final ConnectorStore store;
    private final DatasourceRepository datasources;
    private final IamSettings iam;
    private final IamPrincipalService principals;
    private final AuthMode mode;
    private final ObjectStorageService storage;
    private final MinioProperties minio;
    private final DocumentExporterClient exporter;
    private final FileHubService fileHub;
    private final String notifyDefault;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.repo.EngineInstanceRepository engines;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    public IntegrationController(ConnectorStore store, DatasourceRepository datasources, IamSettings iam,
                                 IamPrincipalService principals, AuthMode mode, ObjectStorageService storage,
                                 MinioProperties minio, DocumentExporterClient exporter, FileHubService fileHub,
                                 @Value("${app.notify.base-url:}") String notifyDefault) {
        this.store = store;
        this.datasources = datasources;
        this.iam = iam;
        this.principals = principals;
        this.mode = mode;
        this.storage = storage;
        this.minio = minio;
        this.exporter = exporter;
        this.fileHub = fileHub;
        this.notifyDefault = notifyDefault == null ? "" : notifyDefault.trim();
    }

    // --- read -----------------------------------------------------------------------------------

    @GetMapping("/integrations")
    public Map<String, Object> list() {
        Map<String, List<Map<String, Object>>> byType = new LinkedHashMap<>();
        datasources.findAll().stream().sorted(Comparator.comparing(Datasource::getName, String.CASE_INSENSITIVE_ORDER))
                .forEach(d -> byType.computeIfAbsent(ConnectorTypes.DATABASE, k -> new ArrayList<>()).add(database(d)));
        byType.computeIfAbsent(ConnectorTypes.IAM, k -> new ArrayList<>()).add(iamItem());
        byType.computeIfAbsent(ConnectorTypes.OBJECT_STORE, k -> new ArrayList<>()).add(objectStoreItem());
        for (ConnectorStore.Row r : store.byType(ConnectorTypes.FILEHUB))
            byType.computeIfAbsent(ConnectorTypes.FILEHUB, k -> new ArrayList<>()).add(item(r));
        if (engines != null) {
            boolean admin = CurrentPrincipal.get().map(RhPrincipal::admin).orElse(false);
            for (var e : engines.findAllByOrderByIdAsc()) {
                Map<String, Object> m = base("engine-" + e.getId(), ConnectorTypes.ENGINE, e.getName(), admin);
                m.put("enabled", e.isEnabled());
                m.put("status", "unknown");
                Map<String, Object> cfg = new LinkedHashMap<>();
                cfg.put("kind", e.getKind());
                cfg.put("installMethod", e.getInstallMethod());
                if (admin) cfg.put("baseUrl", e.getBaseUrl());
                if (e.getAuthToken() != null && !e.getAuthToken().isBlank()) cfg.put("authToken", ConnectorConfig.MASK);
                m.put("config", cfg);
                byType.computeIfAbsent(ConnectorTypes.ENGINE, k -> new ArrayList<>()).add(m);
            }
        }
        byType.computeIfAbsent(ConnectorTypes.EXPORTER, k -> new ArrayList<>()).add(exporterItem());
        byType.computeIfAbsent(ConnectorTypes.NOTIFY, k -> new ArrayList<>()).add(notifyItem());

        List<Map<String, Object>> cats = new ArrayList<>();
        for (ConnectorTypes.Category c : ConnectorTypes.CATEGORIES) {
            List<Map<String, Object>> items = new ArrayList<>();
            for (String t : c.types()) items.addAll(byType.getOrDefault(t, List.of()));
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("key", c.key());
            m.put("label", c.label());
            m.put("types", c.types());
            m.put("items", items);
            cats.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("categories", cats);
        return out;
    }

    @GetMapping("/integrations/{id}")
    public Map<String, Object> get(@PathVariable String id) {
        return switch (id) {
            case ConnectorTypes.IAM_ID -> iamItem();
            case ConnectorTypes.NOTIFY_ID -> notifyItem();
            case ConnectorTypes.OBJECT_STORE_ID -> objectStoreItem();
            case ConnectorTypes.EXPORTER_ID -> exporterItem();
            default -> item(store.find(id).orElseThrow(() -> new NotFoundException("Integration not found: " + id)));
        };
    }

    /** FileHub connectors usable as a publish/delivery target (ids and names only; any signed-in user). */
    @GetMapping("/integrations/targets/filehub")
    public List<Map<String, Object>> fileHubTargets() {
        return fileHub.targets();
    }

    // --- write (ReportHub admins) ---------------------------------------------------------------

    @PostMapping("/integrations")
    public Map<String, Object> create(@RequestBody SaveBody b) {
        requireAdmin();
        String type = b == null || b.type() == null ? "" : b.type().trim();
        if (!ConnectorTypes.FILEHUB.equals(type)) throw new BadRequestException("Only FileHub connectors can be added");
        String id = b.id() == null || b.id().isBlank() ? "filehub-" + UUID.randomUUID().toString().substring(0, 8) : b.id().trim();
        if (!id.matches("[A-Za-z0-9._-]{1,64}")) throw new BadRequestException("ID may contain letters, digits, . _ - (max 64)");
        if (store.find(id).isPresent() || isReserved(id)) throw new BadRequestException("ID already in use: " + id);
        return save(id, type, b);
    }

    @PutMapping("/integrations/{id}")
    public Map<String, Object> update(@PathVariable String id, @RequestBody SaveBody b) {
        requireAdmin();
        String type = switch (id) {
            case ConnectorTypes.IAM_ID -> ConnectorTypes.IAM;
            case ConnectorTypes.NOTIFY_ID -> ConnectorTypes.NOTIFY;
            case ConnectorTypes.OBJECT_STORE_ID, ConnectorTypes.EXPORTER_ID ->
                    throw new BadRequestException("This integration is set by the deployment configuration");
            default -> store.find(id).map(ConnectorStore.Row::type)
                    .orElseThrow(() -> new NotFoundException("Integration not found: " + id));
        };
        return save(id, type, b == null ? new SaveBody(null, null, null, null, Map.of()) : b);
    }

    @DeleteMapping("/integrations/{id}")
    public void delete(@PathVariable String id) {
        requireAdmin();
        ConnectorStore.Row r = store.find(id).orElseThrow(() -> new NotFoundException("Integration not found: " + id));
        if (!ConnectorTypes.FILEHUB.equals(r.type())) throw new BadRequestException("This integration cannot be deleted");
        store.delete(id);
    }

    /**
     * Health check. Body {@code {"config": {...}}} tests the typed (unsaved) values - a masked/blank
     * secret falls back to the stored one; no body = the saved values, and the result is recorded.
     */
    @PostMapping("/integrations/{id}/test")
    public Map<String, Object> test(@PathVariable String id, @RequestBody(required = false) TestBody b) {
        requireAdmin();
        Map<String, Object> typed = b == null || b.config() == null ? null : b.config();
        Map<String, Object> res;
        switch (id) {
            case ConnectorTypes.IAM_ID -> {
                String url = typed != null && str(typed.get("baseUrl")).length() > 0 ? str(typed.get("baseUrl")) : iam.baseUrl();
                try {
                    res = new LinkedHashMap<>(principals.client().health(url));
                } catch (IamException e) {
                    res = result(false, e.status(), e.getMessage(), 0);
                }
            }
            case ConnectorTypes.NOTIFY_ID -> res = probe(typed != null && str(typed.get("baseUrl")).length() > 0
                    ? str(typed.get("baseUrl")) : notifyBaseUrl(), "");
            case ConnectorTypes.OBJECT_STORE_ID -> {
                long t0 = System.currentTimeMillis();
                String err = storage.healthError();
                res = result(err == null, 0, err == null ? "Bucket " + storage.bucket() + " is reachable" : err, System.currentTimeMillis() - t0);
            }
            case ConnectorTypes.EXPORTER_ID -> res = probe(exporter.exporterUrl(), "/healthz");
            case NEW_FILEHUB_ID -> {
                if (typed == null) throw new BadRequestException("Enter the Base URL and API key to test");
                res = testNewFileHub(typed);
            }
            default -> {
                ConnectorStore.Row r = store.find(id).orElseThrow(() -> new NotFoundException("Integration not found: " + id));
                res = testFileHub(r, typed);
            }
        }
        if (typed == null && store.find(id).isPresent()) {
            store.recordCheck(id, Boolean.TRUE.equals(res.get("ok")), str(res.get("message")));
        }
        return res;
    }

    // --- helpers --------------------------------------------------------------------------------

    private Map<String, Object> save(String id, String type, SaveBody b) {
        ConnectorStore.Row old = store.find(id).orElse(null);
        Map<String, Object> incoming = b.config() == null ? Map.of() : b.config();
        Map<String, Object> clean = new LinkedHashMap<>();
        for (String k : allowedKeys(type)) if (incoming.containsKey(k)) clean.put(k, normalise(k, incoming.get(k)));
        validate(type, clean);
        Map<String, Object> merged = ConnectorConfig.merge(type, old == null ? Map.of() : old.config(), clean, store.encryption());
        String name = b.name() != null && !b.name().isBlank() ? b.name().trim()
                : old != null ? old.name() : defaultName(type);
        boolean enabled = b.enabled() != null ? b.enabled() : old == null || old.enabled();
        RhPrincipal who = CurrentPrincipal.get().orElse(null);
        store.upsert(id, type, name, merged, enabled, who == null ? null : who.username());
        if (ConnectorTypes.IAM.equals(type)) principals.clear();
        return get(id);
    }

    static List<String> allowedKeys(String type) {
        return switch (type) {
            case ConnectorTypes.IAM -> List.of("baseUrl", "cacheTtlSeconds", "timeoutMs", "autoProvisionTenant", "adminRoles", "adminUsers");
            case ConnectorTypes.NOTIFY -> List.of("baseUrl");
            case ConnectorTypes.FILEHUB -> List.of("baseUrl", "apiKey", "systemId", "orgId", "folderPath", "status", "owner", "linkTemplate", "timeoutMs");
            default -> List.of();
        };
    }

    private static Object normalise(String k, Object v) {
        if (v == null) return "";
        if (v instanceof Boolean || v instanceof Number) return v;
        String s = String.valueOf(v).trim();
        if (k.equals("baseUrl")) while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private static void validate(String type, Map<String, Object> c) {
        String url = str(c.get("baseUrl"));
        if (!url.isEmpty() && !url.matches("(?i)https?://\\S+")) throw new BadRequestException("Base URL must start with http:// or https://");
        for (String k : List.of("cacheTtlSeconds", "timeoutMs")) {
            String v = str(c.get(k));
            if (!v.isEmpty() && !v.matches("\\d{1,7}")) throw new BadRequestException(k + " must be a whole number");
        }
        String status = str(c.get("status"));
        if (!status.isEmpty() && !List.of("Draft", "Review", "Approved", "Archived").contains(status))
            throw new BadRequestException("Status must be Draft, Review, Approved or Archived");
        if (ConnectorTypes.FILEHUB.equals(type)) {
            String key = str(c.get("apiKey"));
            if (!key.isEmpty() && !ConnectorConfig.MASK.equals(key) && !key.startsWith("fhk_"))
                throw new BadRequestException("A FileHub API key starts with fhk_");
        }
    }

    /** Pseudo-id used to test a FileHub connector before it is saved for the first time. */
    static final String NEW_FILEHUB_ID = "_new-filehub";

    private Map<String, Object> testNewFileHub(Map<String, Object> typed) {
        String url = str(typed.get("baseUrl"));
        String key = str(typed.get("apiKey"));
        if (url.isEmpty() || key.isEmpty()) throw new BadRequestException("Enter the Base URL and API key to test");
        long t0 = System.currentTimeMillis();
        try {
            Map<String, Object> me = FileHubService.client(url, key, str(typed.get("timeoutMs"))).me();
            Map<String, Object> m = result(true, 200, "Signed in as " + me.get("email") + " (" + me.get("role") + ")", System.currentTimeMillis() - t0);
            m.put("account", me);
            return m;
        } catch (FileHubClient.FileHubException e) {
            return result(false, e.status(), e.getMessage(), System.currentTimeMillis() - t0);
        }
    }

    private Map<String, Object> testFileHub(ConnectorStore.Row r, Map<String, Object> typed) {
        String url = typed != null && !str(typed.get("baseUrl")).isEmpty() ? str(typed.get("baseUrl")) : r.str("baseUrl");
        String key = typed == null ? "" : str(typed.get("apiKey"));
        if (key.isEmpty() || ConnectorConfig.MASK.equals(key)) key = store.secret(r, "apiKey");
        long t0 = System.currentTimeMillis();
        try {
            Map<String, Object> me = FileHubService.client(url, key, r.str("timeoutMs")).me();
            Map<String, Object> m = result(true, 200, "Signed in as " + me.get("email") + " (" + me.get("role") + ")", System.currentTimeMillis() - t0);
            m.put("account", me);
            return m;
        } catch (FileHubClient.FileHubException e) {
            return result(false, e.status(), e.getMessage(), System.currentTimeMillis() - t0);
        }
    }

    private Map<String, Object> probe(String base, String path) {
        long t0 = System.currentTimeMillis();
        if (base == null || !base.matches("(?i)https?://\\S+")) return result(false, 0, "URL is not configured", 0);
        try {
            HttpResponse<Void> r = http.send(HttpRequest.newBuilder(URI.create(base.replaceAll("/+$", "") + path))
                    .timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.discarding());
            boolean ok = path.isEmpty() ? r.statusCode() < 500 : r.statusCode() / 100 == 2;
            return result(ok, r.statusCode(), ok ? "Reachable" : "HTTP " + r.statusCode(), System.currentTimeMillis() - t0);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return result(false, 0, "interrupted", 0);
        } catch (Exception e) {
            return result(false, 0, "Not reachable: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()),
                    System.currentTimeMillis() - t0);
        }
    }

    private static Map<String, Object> result(boolean ok, int status, String message, long ms) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", ok);
        m.put("status", status);
        m.put("message", message);
        m.put("ms", ms);
        m.put("checkedAt", OffsetDateTime.now());
        return m;
    }

    public String notifyBaseUrl() {
        String v = store.find(ConnectorTypes.NOTIFY_ID).map(r -> r.str("baseUrl")).orElse("");
        return v.isEmpty() ? notifyDefault : v;
    }

    private Map<String, Object> base(String id, String type, String name, boolean editable) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("type", type);
        m.put("name", name);
        m.put("enabled", true);
        m.put("editable", editable);
        m.put("scope", "platform");
        return m;
    }

    private Map<String, Object> withRow(Map<String, Object> m, String id) {
        store.find(id).ifPresent(r -> {
            m.put("name", r.name());
            m.put("enabled", r.enabled());
            m.put("status", r.status());
            m.put("lastCheckedAt", r.lastCheckedAt());
            m.put("lastError", r.lastError());
            m.put("updatedAt", r.updatedAt());
            m.put("updatedBy", r.updatedBy());
        });
        m.putIfAbsent("status", "unknown");
        return m;
    }

    private Map<String, Object> item(ConnectorStore.Row r) {
        Map<String, Object> m = base(r.id(), r.type(), r.name(), true);
        m.put("config", ConnectorConfig.mask(r.type(), r.config()));
        m.put("scope", r.scope());
        return withRow(m, r.id());
    }

    private Map<String, Object> database(Datasource d) {
        Map<String, Object> m = base(d.getId(), ConnectorTypes.DATABASE, d.getName(), true);
        String s = d.getStatus();
        m.put("status", d.getLatencyMs() == null || s == null ? "unknown" : s);
        Map<String, Object> cfg = new LinkedHashMap<>();
        cfg.put("engine", d.getEngine());
        cfg.put("host", d.getHost());
        cfg.put("schemaName", d.getSchemaName());
        cfg.put("isDefault", d.isDefault());
        m.put("config", cfg);
        return m;
    }

    private Map<String, Object> iamItem() {
        Map<String, Object> m = base(ConnectorTypes.IAM_ID, ConnectorTypes.IAM, "IAM", true);
        Map<String, Object> cfg = new LinkedHashMap<>();
        Map<String, Object> saved = store.find(ConnectorTypes.IAM_ID).map(ConnectorStore.Row::config).orElse(Map.of());
        for (String k : allowedKeys(ConnectorTypes.IAM)) cfg.put(k, saved.getOrDefault(k, ""));
        m.put("config", cfg);
        m.put("defaults", iam.defaults());
        Map<String, Object> eff = new LinkedHashMap<>();
        eff.put("baseUrl", iam.baseUrl());
        eff.put("cacheTtlSeconds", iam.cacheTtlSeconds());
        eff.put("timeoutMs", iam.timeoutMs());
        eff.put("autoProvisionTenant", iam.autoProvisionTenant());
        eff.put("adminRoles", iam.adminRoles());
        eff.put("adminUsers", iam.adminUsers());
        m.put("effective", eff);
        m.put("authMode", mode.value());
        return withRow(m, ConnectorTypes.IAM_ID);
    }

    private Map<String, Object> notifyItem() {
        Map<String, Object> m = base(ConnectorTypes.NOTIFY_ID, ConnectorTypes.NOTIFY, "Notification service", true);
        Map<String, Object> saved = store.find(ConnectorTypes.NOTIFY_ID).map(ConnectorStore.Row::config).orElse(Map.of());
        m.put("config", new LinkedHashMap<>(Map.of("baseUrl", saved.getOrDefault("baseUrl", ""))));
        m.put("defaults", Map.of("baseUrl", notifyDefault));
        m.put("effective", Map.of("baseUrl", notifyBaseUrl()));
        return withRow(m, ConnectorTypes.NOTIFY_ID);
    }

    private Map<String, Object> objectStoreItem() {
        Map<String, Object> m = base(ConnectorTypes.OBJECT_STORE_ID, ConnectorTypes.OBJECT_STORE, "Built-in object store", false);
        Map<String, Object> cfg = new LinkedHashMap<>();
        cfg.put("endpoint", minio.getEndpoint());
        cfg.put("bucket", minio.getBucket());
        m.put("config", cfg);
        m.put("status", "unknown");
        return m;
    }

    private Map<String, Object> exporterItem() {
        Map<String, Object> m = base(ConnectorTypes.EXPORTER_ID, ConnectorTypes.EXPORTER, "Document exporter", false);
        m.put("config", Map.of("url", exporter.exporterUrl()));
        m.put("status", "unknown");
        return m;
    }

    private static boolean isReserved(String id) {
        return Set.of(ConnectorTypes.IAM_ID, ConnectorTypes.NOTIFY_ID, ConnectorTypes.OBJECT_STORE_ID, ConnectorTypes.EXPORTER_ID, NEW_FILEHUB_ID).contains(id);
    }

    private static String defaultName(String type) {
        return switch (type) {
            case ConnectorTypes.IAM -> "IAM";
            case ConnectorTypes.NOTIFY -> "Notification service";
            case ConnectorTypes.FILEHUB -> "FileHub";
            default -> type;
        };
    }

    private static String str(Object o) { return o == null ? "" : String.valueOf(o).trim(); }

    private static void requireAdmin() {
        RhPrincipal p = CurrentPrincipal.get().orElse(null);
        if (p == null || !p.admin()) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "ReportHub administrators only");
    }
}
