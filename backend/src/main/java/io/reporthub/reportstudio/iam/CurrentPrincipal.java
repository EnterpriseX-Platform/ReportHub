package io.reporthub.reportstudio.iam;

import io.reporthub.reportstudio.security.EdgeBearerAuthFilter;
import io.reporthub.reportstudio.tenancy.TenantContext;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Resolves the {@link RhPrincipal} of any {@link Authentication} this app issues. */
public final class CurrentPrincipal {

    private static final ThreadLocal<RhPrincipal> OVERRIDE = new ThreadLocal<>();

    private CurrentPrincipal() {}

    public static Optional<RhPrincipal> get() {
        RhPrincipal o = OVERRIDE.get();
        if (o != null) return Optional.of(o);
        return Optional.ofNullable(from(SecurityContextHolder.getContext().getAuthentication()));
    }

    /** Background work (render worker) runs as the principal snapshot stored with the job. */
    public static void runAs(RhPrincipal p, Runnable work) {
        RhPrincipal prev = OVERRIDE.get();
        OVERRIDE.set(p);
        try { work.run(); } finally { if (prev == null) OVERRIDE.remove(); else OVERRIDE.set(prev); }
    }

    /** {@link #runAs} returning a value; {@code p == null} runs {@code work} unchanged. */
    public static <T> T callAs(RhPrincipal p, java.util.concurrent.Callable<T> work) throws Exception {
        if (p == null) return work.call();
        RhPrincipal prev = OVERRIDE.get();
        OVERRIDE.set(p);
        try { return work.call(); } finally { if (prev == null) OVERRIDE.remove(); else OVERRIDE.set(prev); }
    }

    public static RhPrincipal from(Authentication auth) {
        if (auth == null || !auth.isAuthenticated() || "anonymousUser".equals(auth.getPrincipal())) return null;
        if (auth instanceof RhAuthentication rh) return rh.getPrincipal();
        boolean admin = auth.getAuthorities().stream().anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
        List<String> portal = EdgeBearerAuthFilter.portalRolesOf(auth);
        return new RhPrincipal(auth.getName(), auth.getName(), portal == null ? "local" : "edge",
                TenantContext.DEFAULT_TENANT, admin,
                portal == null ? null : new HashSet<>(portal), null, Map.of(), null);
    }
}
