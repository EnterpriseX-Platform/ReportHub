package io.reporthub.reportstudio.tenancy;

import io.reporthub.reportstudio.iam.CurrentPrincipal;
import io.reporthub.reportstudio.iam.RhPrincipal;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Tenants and projects. {@code GET /tenancy/mine} feeds the top-bar switcher; the rest is the
 * Settings screen. Platform admins see every tenant, tenant admins only their own.
 */
@RestController
@RequestMapping("/tenancy")
public class TenancyController {

    public record TenantBody(String id, String name, String iamTenantId, Boolean active) {}
    public record ProjectBody(String id, String name, String iamAppCode, Boolean active) {}

    private static final String ID_RE = "[a-z0-9][a-z0-9_-]{0,63}";

    private final TenancyService tenancy;

    public TenancyController(TenancyService tenancy) {
        this.tenancy = tenancy;
    }


    @GetMapping("/mine")
    public Map<String, Object> mine() {
        RhPrincipal p = me();
        TenantContext.Scope s = TenantContext.current().orElse(tenancy.scopeFor(p, null));
        Tenant t = TenantContext.callAs(null, () -> tenancy.tenants().findById(s.tenantId()).orElse(null));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tenant", Map.of("id", s.tenantId(), "name", t == null ? s.tenantId() : t.getName()));
        out.put("project", s.projectId());
        out.put("projects", tenancy.projectsOf(s.tenantId()).stream()
                .map(x -> Map.of("id", x.getId(), "name", x.getName())).toList());
        return out;
    }

    @GetMapping("/tenants")
    public List<Tenant> tenants() {
        RhPrincipal p = me();
        return TenantContext.callAs(null, () -> TenancyService.isPlatformAdmin(p)
                ? tenancy.tenants().findAll()
                : tenancy.tenants().findById(p.tenantId()).map(List::of).orElse(List.of()));
    }

    @PostMapping("/tenants")
    @ResponseStatus(HttpStatus.CREATED)
    public Tenant createTenant(@RequestBody TenantBody b) {
        requirePlatformAdmin();
        String id = validId(b.id());
        return TenantContext.callAs(null, () -> {
            if (tenancy.tenants().existsById(id)) throw new BadRequestException("Tenant exists: " + id);
            Tenant t = new Tenant();
            t.setId(id);
            t.setName(blankTo(b.name(), id));
            t.setIamTenantId(blankTo(b.iamTenantId(), null));
            tenancy.tenants().save(t);
            Project p = new Project();
            p.setTenantId(id);
            p.setId(TenantContext.DEFAULT_PROJECT);
            p.setName("Default");
            tenancy.projects().save(p);
            tenancy.seedCategories(id, TenantContext.DEFAULT_PROJECT);
            tenancy.invalidate();
            return t;
        });
    }

    @PutMapping("/tenants/{id}")
    public Tenant updateTenant(@PathVariable String id, @RequestBody TenantBody b) {
        requireTenantAdmin(id);
        return TenantContext.callAs(null, () -> {
            Tenant t = tenancy.tenants().findById(id).orElseThrow(() -> new NotFoundException("Tenant " + id));
            if (b.name() != null && !b.name().isBlank()) t.setName(b.name().trim());
            if (b.iamTenantId() != null) t.setIamTenantId(blankTo(b.iamTenantId(), null));
            if (b.active() != null && TenancyService.isPlatformAdmin(me())) t.setActive(b.active());
            return tenancy.tenants().save(t);
        });
    }

    @GetMapping("/tenants/{id}/projects")
    public List<Project> projects(@PathVariable String id) {
        requireTenantAdmin(id);
        return TenantContext.callAs(null, () -> tenancy.projects().findByTenantIdOrderByName(id));
    }

    @PostMapping("/tenants/{id}/projects")
    @ResponseStatus(HttpStatus.CREATED)
    public Project createProject(@PathVariable String id, @RequestBody ProjectBody b) {
        requireTenantAdmin(id);
        String pid = validId(b.id());
        return TenantContext.callAs(null, () -> {
            if (!tenancy.tenants().existsById(id)) throw new NotFoundException("Tenant " + id);
            if (tenancy.projects().existsById(new Project.Key(id, pid))) throw new BadRequestException("Project exists: " + pid);
            Project p = new Project();
            p.setTenantId(id);
            p.setId(pid);
            p.setName(blankTo(b.name(), pid));
            p.setIamAppCode(blankTo(b.iamAppCode(), null));
            Project saved = tenancy.projects().save(p);
            tenancy.seedCategories(id, pid);
            tenancy.invalidate();
            return saved;
        });
    }

    @PutMapping("/tenants/{id}/projects/{pid}")
    public Project updateProject(@PathVariable String id, @PathVariable String pid, @RequestBody ProjectBody b) {
        requireTenantAdmin(id);
        return TenantContext.callAs(null, () -> {
            Project p = tenancy.projects().findById(new Project.Key(id, pid))
                    .orElseThrow(() -> new NotFoundException("Project " + pid));
            if (b.name() != null && !b.name().isBlank()) p.setName(b.name().trim());
            if (b.iamAppCode() != null) p.setIamAppCode(blankTo(b.iamAppCode(), null));
            if (b.active() != null) {
                if (!b.active() && TenantContext.DEFAULT_PROJECT.equals(pid)) {
                    throw new BadRequestException("The default project cannot be deactivated");
                }
                p.setActive(b.active());
            }
            Project saved = tenancy.projects().save(p);
            tenancy.invalidate();
            return saved;
        });
    }

    private RhPrincipal me() {
        return CurrentPrincipal.get().orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
    }

    private void requirePlatformAdmin() {
        if (!TenancyService.isPlatformAdmin(me())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Platform administrators only");
    }

    private void requireTenantAdmin(String tenantId) {
        RhPrincipal p = me();
        if (TenancyService.isPlatformAdmin(p)) return;
        if (!p.admin() || !tenantId.equals(p.tenantId())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Not an administrator of this tenant");
    }

    private static String validId(String id) {
        String v = id == null ? "" : id.trim().toLowerCase();
        if (!v.matches(ID_RE)) throw new BadRequestException("Id must be lowercase letters, digits, '-' or '_' (max 64)");
        return v;
    }

    private static String blankTo(String s, String dflt) {
        return s == null || s.isBlank() ? dflt : s.trim();
    }
}
