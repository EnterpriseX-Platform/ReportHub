package io.reporthub.reportstudio.iam;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Thin HTTP client for the IAM service.
 *
 * <p>Endpoints used (all answer {@code {"success":true,"data":...}}):
 * <ul>
 *   <li>{@code POST /api/auth/login} — username/password → token + user</li>
 *   <li>{@code GET /api/auth/me} — validates a bearer token → id, username, tenantId, isAdmin</li>
 *   <li>{@code GET /api/perms/by-user} — the caller's roles, responsibilities and per-object
 *       permission matrix (object code → canView/canCreate/...)</li>
 *   <li>{@code GET /api/users/{id}} — departmentCode, positionCode, employeeCode, tenant</li>
 *   <li>{@code GET /api/perms/resolve?objectCode=} and {@code GET /api/perms/check} — single-object checks</li>
 * </ul>
 * The aggregate {@code GET /api/perms/resolve} (no objectCode) is keyed by role, not by object,
 * so the object matrix is taken from {@code /api/perms/by-user}.
 */
public class IamClient {

    /** ReportHub action → IAM permission flag. */
    public static final Map<String, String> ACTION_FLAGS = Map.of(
            "view", "canView",
            "create", "canCreate",
            "update", "canEdit",
            "delete", "canDelete",
            "approve", "canApprove",
            "execute", "canExport");

    public record Login(String token, RhPrincipalSeed user) {}

    /** IAM user statuses that may sign in; anything else (suspended, inactive, locked ...) is refused. */
    static final Set<String> ACTIVE_STATUSES = Set.of("active", "enabled");

    /** The user exists but IAM marks the account as not active. */
    public static class UserInactiveException extends IamException {
        public UserInactiveException(String message) { super(403, message); }
    }

    /** What IAM says about a user before it is mapped to a ReportHub tenant. */
    public record RhPrincipalSeed(String id, String username, String displayName, String iamTenantId,
                                  String tenantCode, String tenantName, boolean admin,
                                  Set<String> roles, Set<String> responsibilities,
                                  Map<String, String> attributes, Map<String, Set<String>> objectPerms) {}

    private final Supplier<String> baseUrl;
    private final HttpClient http;
    private final ObjectMapper json;
    private final Supplier<Duration> timeoutSource;

    public IamClient(Supplier<String> baseUrl, ObjectMapper json, Duration timeout) {
        this(baseUrl, json, () -> timeout);
    }

    /** {@code timeout} is read per request, so a timeout saved on Integrations applies without a restart. */
    public IamClient(Supplier<String> baseUrl, ObjectMapper json, Supplier<Duration> timeout) {
        this.baseUrl = baseUrl;
        this.json = json;
        this.timeoutSource = timeout;
        // HTTP/1.1 only: the IAM service (Node) does not answer the h2c upgrade the JDK client sends
        // by default, which surfaced as empty replies / 502 / 401 on login.
        this.http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(timeout.get()).build();
    }

    public Login login(String username, String password) {
        Map<String, String> body = Map.of("username", username, "password", password);
        JsonNode data = call("POST", "/api/auth/login", null, body);
        String token = data.path("token").asText(null);
        if (token == null) throw new IamException(502, "IAM login returned no token");
        return new Login(token, load(token));
    }

    /** Validate {@code token} and collect everything ReportHub needs about the caller. */
    public RhPrincipalSeed load(String token) {
        JsonNode me = call("GET", "/api/auth/me", token, null);
        String id = me.path("id").asText(null);
        Map<String, String> attrs = new LinkedHashMap<>();
        String tenantCode = null, tenantName = null;
        if (id != null) {
            try {
                JsonNode u = call("GET", "/api/users/" + enc(id), token, null);
                putIf(attrs, "departmentCode", u.path("departmentCode"));
                putIf(attrs, "positionCode", u.path("positionCode"));
                putIf(attrs, "employeeCode", u.path("employeeCode"));
                putIf(attrs, "email", u.path("email"));
                String status = text(u.path("status"));
                if (status != null && !ACTIVE_STATUSES.contains(status.toLowerCase(java.util.Locale.ROOT))) {
                    throw new UserInactiveException("User account is " + status);
                }
                tenantCode = text(u.path("tenant").path("code"));
                tenantName = text(u.path("tenant").path("name"));
            } catch (UserInactiveException e) {
                throw e;
            } catch (IamException e) {
                // user detail is optional (some deployments restrict it); attributes stay empty
            }
        }
        putIf(attrs, "email", me.path("email"));
        attrs.put("userId", id == null ? "" : id);

        Set<String> roles = new LinkedHashSet<>();
        Set<String> resps = new LinkedHashSet<>();
        Map<String, Set<String>> perms = new HashMap<>();
        JsonNode by = call("GET", "/api/perms/by-user", token, null);
        by.path("roles").forEach(r -> { if (inEffect(r)) addText(roles, r.path("code")); });
        by.path("responsibilities").forEach(r -> { if (inEffect(r)) addText(resps, r.path("code")); });
        // Roles granted through a responsibility: by-user lists only direct roles, so resolve them via
        // /api/perms/by-resp (linkedRoles) and from the role sources of the merged permissions.
        by.path("permissions").forEach(p -> p.path("sources").forEach(src -> {
            if ("role".equals(src.path("type").asText())) addText(roles, src.path("code"));
        }));
        by.path("responsibilities").forEach(r -> {
            String rid = text(r.path("id"));
            if (rid == null || !inEffect(r)) return;
            try {
                JsonNode rr = call("GET", "/api/perms/by-resp?responsibilityId=" + enc(rid), token, null);
                rr.path("linkedRoles").forEach(lr -> addText(roles, lr.path("code")));
            } catch (IamException e) {
                // not allowed to read responsibility detail: keep what by-user gave
            }
        });
        by.path("permissions").forEach(p -> {
            String code = text(p.path("object").path("code"));
            if (code == null || !inEffect(p)) return;
            Set<String> acts = perms.computeIfAbsent(code, k -> new LinkedHashSet<>());
            JsonNode m = p.path("permissions");
            ACTION_FLAGS.forEach((action, flag) -> { if (m.path(flag).asBoolean(false)) acts.add(action); });
        });

        return new RhPrincipalSeed(id, me.path("username").asText(), firstNonBlank(text(me.path("fullName")), me.path("username").asText()),
                text(me.path("tenantId")), tenantCode, tenantName, me.path("isAdmin").asBoolean(false),
                roles, resps, attrs, perms);
    }

    /** {@code GET /api/perms/check} — true when IAM grants {@code action} on {@code objectCode}. */
    public boolean check(String token, String objectCode, String action) {
        String flag = ACTION_FLAGS.getOrDefault(action, action);
        JsonNode d = call("GET", "/api/perms/check?objectCode=" + enc(objectCode) + "&action=" + enc(flag), token, null);
        return d.path("allowed").asBoolean(false);
    }

    /** Reachability probe for the Settings screen. */
    public Map<String, Object> health() {
        return health(baseUrl.get());
    }

    /**
     * Probe {@code base} (which may be an unsaved URL typed on the Settings screen): ok only when
     * {@code GET /api/health} answers 2xx. Never throws - an unreachable host is reported in the map.
     */
    public Map<String, Object> health(String base) {
        long t0 = System.currentTimeMillis();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("baseUrl", base);
        if (base == null || base.isBlank() || !base.matches("(?i)https?://.+")) {
            out.put("ok", false);
            out.put("status", 0);
            out.put("message", "Base URL must start with http:// or https://");
            return out;
        }
        String b = base.trim().replaceAll("/+$", "");
        try {
            HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create(b + "/api/health"))
                    .timeout(timeoutSource.get()).header("Accept", "application/json").GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            String body = r.body() == null ? "" : r.body();
            out.put("ok", r.statusCode() / 100 == 2);
            out.put("status", r.statusCode());
            out.put("message", healthMessage(r.statusCode(), body));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            out.put("ok", false);
            out.put("status", 0);
            out.put("message", "interrupted");
        } catch (Exception e) {
            out.put("ok", false);
            out.put("status", 0);
            out.put("message", unreachableMessage(e));
        }
        out.put("ms", System.currentTimeMillis() - t0);
        return out;
    }

    /** Short, human message for a health answer - never the raw (possibly HTML) body. */
    static String healthMessage(int status, String body) {
        if (status / 100 == 2) return "IAM is reachable";
        String b = body == null ? "" : body.trim();
        if (b.startsWith("{")) {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"(?:message|error)\"\\s*:\\s*\"([^\"]{1,160})\"").matcher(b);
            if (m.find()) return "IAM answered HTTP " + status + ": " + m.group(1);
        }
        return status == 404 ? "IAM answered HTTP 404 - check the base URL (it should end with the IAM context path)"
                : "IAM answered HTTP " + status;
    }

    static String unreachableMessage(Throwable e) {
        Throwable c = e;
        while (c != null) {
            if (c instanceof java.net.ConnectException) return "Cannot connect to the IAM service - check the host and port";
            if (c instanceof java.net.UnknownHostException) return "Unknown IAM host - check the base URL";
            if (c instanceof java.net.http.HttpTimeoutException) return "IAM did not answer in time";
            c = c.getCause();
        }
        return "Cannot reach the IAM service";
    }

    // ---- plumbing ----

    private JsonNode call(String method, String path, String token, Object body) {
        HttpResponse<String> r = send(method, path, token, body);
        JsonNode root;
        try {
            root = json.readTree(r.body() == null || r.body().isBlank() ? "{}" : r.body());
        } catch (Exception e) {
            throw new IamException(r.statusCode(), "IAM answered " + r.statusCode() + " with a non-JSON body");
        }
        if (r.statusCode() >= 400 || !root.path("success").asBoolean(true)) {
            int st = r.statusCode() >= 400 ? r.statusCode() : 502;
            throw new IamException(st, root.path("error").asText("IAM request failed (" + r.statusCode() + ")"));
        }
        return root.has("data") ? root.get("data") : root;
    }

    private HttpResponse<String> send(String method, String path, String token, Object body) {
        String base = baseUrl.get();
        if (base == null || base.isBlank()) throw new IamException(503, "IAM base URL is not configured");
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path))
                    .timeout(timeoutSource.get())
                    .header("Accept", "application/json");
            if (token != null) b.header("Authorization", "Bearer " + token);
            if (body != null) {
                b.header("Content-Type", "application/json")
                 .method(method, HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
            } else {
                b.method(method, HttpRequest.BodyPublishers.noBody());
            }
            return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IamException("IAM call interrupted", e);
        } catch (IamException e) {
            throw e;
        } catch (Exception e) {
            String cause = e.getMessage() == null || e.getMessage().isBlank() ? e.getClass().getSimpleName() : e.toString();
            org.slf4j.LoggerFactory.getLogger(IamClient.class).warn("IAM call {} {} failed: {}", method, path, e.toString());
            throw new IamException("Identity service is unavailable; please retry.", e);
        }
    }

    /**
     * IAM's by-user endpoint does not filter on effective/expiry dates; when an entry carries them
     * ({@code effectiveDate} / {@code expireDate}, ISO), honour them here.
     */
    static boolean inEffect(JsonNode n) {
        java.time.Instant now = java.time.Instant.now();
        java.time.Instant from = instant(n.path("effectiveDate"));
        java.time.Instant to = instant(n.path("expireDate"));
        return (from == null || !now.isBefore(from)) && (to == null || now.isBefore(to));
    }

    private static java.time.Instant instant(JsonNode n) {
        String t = text(n);
        if (t == null) return null;
        try { return java.time.OffsetDateTime.parse(t).toInstant(); } catch (Exception ignored) { }
        try { return java.time.Instant.parse(t); } catch (Exception ignored) { }
        try { return java.time.LocalDate.parse(t.substring(0, Math.min(10, t.length()))).atStartOfDay(java.time.ZoneOffset.UTC).toInstant(); }
        catch (Exception ignored) { return null; }
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }

    private static String text(JsonNode n) {
        return n == null || n.isMissingNode() || n.isNull() || n.asText().isBlank() ? null : n.asText();
    }

    private static void putIf(Map<String, String> m, String k, JsonNode n) {
        String v = text(n);
        if (v != null) m.put(k, v);
    }

    private static void addText(Set<String> s, JsonNode n) {
        String v = text(n);
        if (v != null) s.add(v);
    }

    private static String firstNonBlank(String a, String b) { return a != null ? a : b; }
}
