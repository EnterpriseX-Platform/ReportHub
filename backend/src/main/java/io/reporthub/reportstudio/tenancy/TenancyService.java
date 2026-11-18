package io.reporthub.reportstudio.tenancy;

import io.reporthub.reportstudio.iam.RhPrincipal;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Tenant/project lookups used per request; project lists are cached briefly. */
@Service
public class TenancyService {

    private record Cached(List<Project> projects, long at) {}

    private static final long TTL_MS = 30_000;

    private final TenantRepository tenants;
    private final ProjectRepository projects;
    private final Map<String, Cached> cache = new ConcurrentHashMap<>();

    private final io.reporthub.reportstudio.repo.ReportCategoryRepository categories;

    public TenancyService(TenantRepository tenants, ProjectRepository projects,
                          io.reporthub.reportstudio.repo.ReportCategoryRepository categories) {
        this.tenants = tenants;
        this.projects = projects;
        this.categories = categories;
    }

    /**
     * A new project starts with the report categories of the tenant's default project (or of the
     * platform default), under fresh ids — category ids are global keys, and reports need one.
     */
    /** A new tenant/project starts with one "General" category (not a copy of another tenant's list). */
    public void seedCategories(String tenantId, String projectId) {
        TenantContext.runAs(new TenantContext.Scope(tenantId, projectId), () -> {
            if (!categories.findAllByOrderBySortOrderAsc().isEmpty()) return;
            var n = new io.reporthub.reportstudio.domain.ReportCategory();
            n.setId(io.reporthub.reportstudio.util.Cuid2.createId(16));
            n.setRef("GEN");
            n.setName("General");
            n.setDescription("Default category");
            n.setMinReports(0);
            n.setSortOrder(0);
            categories.save(n);
        });
    }

    public List<Project> projectsOf(String tenantId) {
        Cached c = cache.get(tenantId);
        if (c != null && System.currentTimeMillis() - c.at() < TTL_MS) return c.projects();
        List<Project> list = TenantContext.callAs(null, () -> projects.findByTenantIdOrderByName(tenantId))
                .stream().filter(Project::isActive).toList();
        cache.put(tenantId, new Cached(list, System.currentTimeMillis()));
        return list;
    }

    public void invalidate() { cache.clear(); }

    /**
     * Scope for a caller asking for {@code requestedProject} (may be null): that project when it
     * exists in the caller's tenant, else the tenant's {@code default} project, else its first one.
     *
     * An unknown or deactivated requested project falls back to the default (see {@link #isActiveProject}).
     */
    public TenantContext.Scope scopeFor(RhPrincipal p, String requestedProject) {
        String tenant = p == null || p.tenantId() == null ? TenantContext.DEFAULT_TENANT : p.tenantId();
        List<Project> list = projectsOf(tenant);
        if (requestedProject != null && !requestedProject.isBlank()) {
            String want = requestedProject.trim();
            if (list.stream().anyMatch(x -> x.getId().equals(want))) return new TenantContext.Scope(tenant, want);
        }
        String pick = list.stream().map(Project::getId).filter(TenantContext.DEFAULT_PROJECT::equals).findFirst()
                .orElse(list.isEmpty() ? TenantContext.DEFAULT_PROJECT : list.get(0).getId());
        return new TenantContext.Scope(tenant, pick);
    }

    /** True when {@code projectId} is an active project of the caller's tenant. */
    public boolean isActiveProject(RhPrincipal p, String projectId) {
        String tenant = p == null || p.tenantId() == null ? TenantContext.DEFAULT_TENANT : p.tenantId();
        return projectId != null && projectsOf(tenant).stream().anyMatch(x -> x.getId().equals(projectId.trim()));
    }

    /** Platform admins (admins of the {@code default} tenant) manage every tenant. */
    public static boolean isPlatformAdmin(RhPrincipal p) {
        return p != null && p.admin() && TenantContext.DEFAULT_TENANT.equals(p.tenantId());
    }

    public TenantRepository tenants() { return tenants; }
    public ProjectRepository projects() { return projects; }
}
