package io.reporthub.reportstudio.tenancy;

import io.reporthub.reportstudio.iam.CurrentPrincipal;
import io.reporthub.reportstudio.iam.RhPrincipal;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.lang.NonNull;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Sets {@link TenantContext} for the request: tenant from the authenticated principal, project
 * from {@code X-Project} (header) or {@code project} (query). Runs after the auth filters.
 * Anonymous callers get the default scope, except public share links (token-addressed rows of
 * any tenant), which run unscoped.
 */
public class TenantContextFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Project";
    /** Set when the requested project is unknown or inactive; value = the project actually used. */
    public static final String FALLBACK_HEADER = "X-Project-Fallback";

    private final TenancyService tenancy;

    public TenantContextFilter(TenancyService tenancy) {
        this.tenancy = tenancy;
    }

    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest req, @NonNull HttpServletResponse res,
                                    @NonNull FilterChain chain) throws ServletException, IOException {
        RhPrincipal p = CurrentPrincipal.get().orElse(null);
        String path = req.getRequestURI().substring(req.getContextPath() == null ? 0 : req.getContextPath().length());
        TenantContext.Scope scope = null;
        if (p != null || !path.startsWith("/public/")) {
            // identity endpoints never depend on a project: a stale X-Project must not lock anyone out
            String requested = path.startsWith("/auth/") ? null : req.getHeader(HEADER);
            if (!path.startsWith("/auth/") && (requested == null || requested.isBlank())) requested = req.getParameter("project");
            scope = tenancy.scopeFor(p, requested);
            if (requested != null && !requested.isBlank() && !tenancy.isActiveProject(p, requested)) {
                res.setHeader(FALLBACK_HEADER, scope.projectId());
            }
        }
        TenantContext.set(scope);
        try {
            chain.doFilter(req, res);
        } finally {
            TenantContext.clear();
        }
    }
}
