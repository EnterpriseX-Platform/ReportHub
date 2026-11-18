package io.reporthub.reportstudio.iam;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * IAM connection settings. Values saved on Integrations → Identity (the {@code iam} row of the
 * {@code connector} table) win; the {@code app.iam.*} properties (env) are the defaults.
 */
@Component
public class IamSettings {

    static final String KEY_BASE_URL = "iam.base-url";

    private final JdbcTemplate jdbc;
    private final String defaultBaseUrl;
    private final int cacheTtlSeconds;
    private final int timeoutMs;
    private boolean defaultAutoProvision = true;
    private String defaultAdminRoles = "", defaultAdminUsers = "";
    private io.reporthub.reportstudio.integration.ConnectorStore connectors;
    private java.util.Set<String> adminRoles = java.util.Set.of();
    private java.util.Set<String> adminUsers = java.util.Set.of();

    /** IAM role codes / usernames treated as ReportHub admins ({@code app.iam.admin-roles} / {@code admin-users}). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setAdmins(@Value("${app.iam.admin-roles:}") String roles, @Value("${app.iam.admin-users:}") String users) {
        this.defaultAdminRoles = roles == null ? "" : roles;
        this.defaultAdminUsers = users == null ? "" : users;
        this.adminRoles = csv(roles);
        this.adminUsers = csv(users);
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setAutoProvisionDefault(@Value("${app.iam.auto-provision-tenant:true}") boolean v) { this.defaultAutoProvision = v; }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setConnectors(io.reporthub.reportstudio.integration.ConnectorStore connectors) { this.connectors = connectors; }

    /** Saved override of one IAM setting ("" = not overridden). */
    private String saved(String key) {
        if (connectors == null) return "";
        return connectors.find(io.reporthub.reportstudio.integration.ConnectorTypes.IAM_ID)
                .map(r -> r.str(key)).orElse("");
    }

    public void setAdminRolesAndUsers(String roles, String users) { setAdmins(roles, users); }

    /** True when the IAM user is a ReportHub admin by configuration. */
    public boolean isConfiguredAdmin(String username, java.util.Collection<String> roles) {
        java.util.Set<String> adminUsers = savedOr("adminUsers", this.adminUsers);
        java.util.Set<String> adminRoles = savedOr("adminRoles", this.adminRoles);
        if (username != null && adminUsers.contains(username.toLowerCase(java.util.Locale.ROOT))) return true;
        if (roles != null) for (String r : roles) if (r != null && adminRoles.contains(r.toLowerCase(java.util.Locale.ROOT))) return true;
        return false;
    }

    private java.util.Set<String> savedOr(String key, java.util.Set<String> def) {
        String v = saved(key);
        return v.isEmpty() ? def : csv(v);
    }

    static java.util.Set<String> csv(String v) {
        if (v == null || v.isBlank()) return java.util.Set.of();
        java.util.Set<String> out = new java.util.HashSet<>();
        for (String x : v.split(",")) if (!x.isBlank()) out.add(x.trim().toLowerCase(java.util.Locale.ROOT));
        return java.util.Set.copyOf(out);
    }

    public IamSettings(JdbcTemplate jdbc,
                       @Value("${app.iam.base-url:}") String defaultBaseUrl,
                       @Value("${app.iam.cache-ttl-seconds:60}") int cacheTtlSeconds,
                       @Value("${app.iam.timeout-ms:5000}") int timeoutMs) {
        this.jdbc = jdbc;
        this.defaultBaseUrl = defaultBaseUrl;
        this.cacheTtlSeconds = cacheTtlSeconds;
        this.timeoutMs = timeoutMs;
    }

    public String baseUrl() {
        String v = saved("baseUrl");
        return trimSlash(v.isEmpty() ? defaultBaseUrl : v);
    }

    /** True when saved overrides are available (false in plain unit tests). */
    public boolean hasConnectors() { return connectors != null; }

    public int cacheTtlSeconds() { return intOr(saved("cacheTtlSeconds"), cacheTtlSeconds); }
    public int timeoutMs() { return intOr(saved("timeoutMs"), timeoutMs); }
    public boolean autoProvisionTenant() {
        String v = saved("autoProvisionTenant");
        return v.isEmpty() ? defaultAutoProvision : Boolean.parseBoolean(v);
    }
    public String adminRoles() { String v = saved("adminRoles"); return v.isEmpty() ? defaultAdminRoles : v; }
    public String adminUsers() { String v = saved("adminUsers"); return v.isEmpty() ? defaultAdminUsers : v; }

    /** The env/property defaults (shown as placeholders on the Integrations screen). */
    public java.util.Map<String, Object> defaults() {
        java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("baseUrl", trimSlash(defaultBaseUrl));
        m.put("cacheTtlSeconds", cacheTtlSeconds);
        m.put("timeoutMs", timeoutMs);
        m.put("autoProvisionTenant", defaultAutoProvision);
        m.put("adminRoles", defaultAdminRoles);
        m.put("adminUsers", defaultAdminUsers);
        return m;
    }

    private static int intOr(String v, int def) {
        try { return v.isEmpty() ? def : Integer.parseInt(v); } catch (NumberFormatException e) { return def; }
    }

    static String trimSlash(String s) {
        if (s == null) return "";
        String t = s.trim();
        while (t.endsWith("/")) t = t.substring(0, t.length() - 1);
        return t;
    }
}
