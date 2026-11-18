package io.reporthub.reportstudio.iam;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.reporthub.reportstudio.tenancy.Project;
import io.reporthub.reportstudio.tenancy.ProjectRepository;
import io.reporthub.reportstudio.tenancy.Tenant;
import io.reporthub.reportstudio.tenancy.TenantContext;
import io.reporthub.reportstudio.tenancy.TenantRepository;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Turns an IAM token into an {@link RhPrincipal}, caching the result per token for a short TTL
 * ({@code app.iam.cache-ttl-seconds}) so each request does not hit IAM.
 */
@Service
public class IamPrincipalService {

    private record Cached(RhPrincipal principal, long expiresAt) {}

    private static final int MAX_ENTRIES = 5000;

    private final IamClient client;
    private final IamSettings settings;
    private final TenantRepository tenants;
    private final ProjectRepository projects;
    private final boolean autoProvision;

    /** Seeds report categories into an auto-provisioned tenant (optional for tests). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.tenancy.TenancyService tenancy;

    /** Holds the local sign-out denylist for IAM tokens (optional for tests). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setJwt(io.reporthub.reportstudio.security.JwtService jwt) { this.jwt = jwt; }
    private io.reporthub.reportstudio.security.JwtService jwt;
    private final Map<String, Cached> cache = new LinkedHashMap<>(256, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Cached> e) { return size() > MAX_ENTRIES; }
    };

    @org.springframework.beans.factory.annotation.Autowired
    public IamPrincipalService(IamSettings settings, ObjectMapper json,
                               TenantRepository tenants, ProjectRepository projects,
                               @Value("${app.iam.auto-provision-tenant:true}") boolean autoProvision) {
        this(new IamClient(settings::baseUrl, json, () -> Duration.ofMillis(settings.timeoutMs())),
                settings, tenants, projects, autoProvision);
    }

    IamPrincipalService(IamClient client, IamSettings settings, TenantRepository tenants,
                        ProjectRepository projects, boolean autoProvision) {
        this.client = client;
        this.settings = settings;
        this.tenants = tenants;
        this.projects = projects;
        this.autoProvision = autoProvision;
    }

    public IamClient client() { return client; }

    public IamClient.Login login(String username, String password) {
        IamClient.Login l = client.login(username, password);
        put(l.token(), toPrincipal(l.user()));
        return l;
    }

    /** Principal for {@code token}; throws {@link IamException} when IAM rejects it. */
    public RhPrincipal resolve(String token) {
        if (jwt != null && jwt.isForeignRevoked(token)) throw new IamException(401, "Token was signed out");
        String key = hash(token);
        long now = System.currentTimeMillis();
        synchronized (cache) {
            Cached e = cache.get(key);
            if (e != null && e.expiresAt() > now) return e.principal();
        }
        RhPrincipal p = toPrincipal(client.load(token));
        put(token, p);
        return p;
    }

    public void evict(String token) {
        synchronized (cache) { cache.remove(hash(token)); }
    }

    public void clear() {
        synchronized (cache) { cache.clear(); }
    }

    private void put(String token, RhPrincipal p) {
        long exp = System.currentTimeMillis() + settings.cacheTtlSeconds() * 1000L;
        synchronized (cache) { cache.put(hash(token), new Cached(p, exp)); }
    }

    RhPrincipal toPrincipal(IamClient.RhPrincipalSeed s) {
        String tenantId = TenantContext.callAs(null, () -> mapTenant(s));
        boolean admin = s.admin() || settings.isConfiguredAdmin(s.username(), s.roles());
        return new RhPrincipal(s.username(), s.displayName(), "iam", tenantId, admin,
                s.roles(), s.responsibilities(), s.attributes(), s.objectPerms());
    }

    /** IAM tenant → ReportHub tenant, creating it (with a default project) on first sight. */
    private String mapTenant(IamClient.RhPrincipalSeed s) {
        if (s.iamTenantId() == null) return TenantContext.DEFAULT_TENANT;
        return tenants.findByIamTenantId(s.iamTenantId()).map(Tenant::getId).orElseGet(() -> {
            if (!(settings != null && settings.hasConnectors() ? settings.autoProvisionTenant() : autoProvision)) throw new IamException(403, "Tenant is not registered in ReportHub");
            String id = slug(s.tenantCode() != null ? s.tenantCode() : "t-" + s.iamTenantId());
            Tenant t = tenants.findById(id).orElseGet(Tenant::new);
            if (t.getId() == null) {
                t.setId(id);
                t.setName(s.tenantName() != null ? s.tenantName() : id);
            }
            t.setIamTenantId(s.iamTenantId());
            tenants.save(t);
            if (projects.findByTenantIdOrderByName(id).isEmpty()) {
                Project p = new Project();
                p.setTenantId(id);
                p.setId(TenantContext.DEFAULT_PROJECT);
                p.setName("Default");
                projects.save(p);
                if (tenancy != null) tenancy.seedCategories(id, TenantContext.DEFAULT_PROJECT);
            }
            return id;
        });
    }

    static String slug(String s) {
        String v = s.toLowerCase().replaceAll("[^a-z0-9_-]+", "-").replaceAll("^-+|-+$", "");
        if (v.isEmpty()) v = "tenant";
        return v.length() > 64 ? v.substring(0, 64) : v;
    }

    private static String hash(String token) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
