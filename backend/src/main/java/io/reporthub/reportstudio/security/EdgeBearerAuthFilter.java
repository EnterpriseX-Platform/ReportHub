package io.reporthub.reportstudio.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.lang.NonNull;
import org.springframework.security.core.Authentication;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;

/**
 * EDGE AUTH — accept the OIDC access token that a gateway auth proxy (e.g. oauth2-proxy)
 * forwards, so a page in another host app
 * (via {@code rs-export.js}) can run reports as the real signed-in user.
 *
 * <p>Bearer contract:
 * {@code X-Forwarded-Access-Token} first, {@code Authorization: Bearer} fallback,
 * JWKS signature/issuer/expiry verification, {@code azp} allow-list, {@code sub} required).
 *
 * <p>Design notes:
 * <ul>
 *   <li>Report Studio gates on roles ({@code anyRequest().authenticated()} plus {@code ROLE_ADMIN} on writes),
 *       so an edge caller is granted {@code ROLE_<granted-role>} — default {@code USER},
 *       which is enough for {@code POST /reports/*&#47;run} and reads, but never for the
 *       admin write surface. Least privilege: an embedded page cannot mutate the registry.</li>
 *   <li>The principal is a human-readable username ({@code preferred_username} → {@code email}
 *       → {@code sub}) so {@code job.requestedBy} shows the real user rather than a UUID. The
 *       raw token is kept as the credentials in case a future identity-provider permission lookup needs it.</li>
 * </ul>
 *
 * <p>Runs AFTER {@link JwtAuthenticationFilter} and no-ops when the context is already
 * authenticated, so Report Studio's own {@code rs.token} (admin UI) always wins and this is
 * purely a fallback. An unparseable app token leaves the context empty, so a Keycloak token
 * arriving in {@code Authorization} still lands here. Never rejects: an auth failure falls
 * through anonymous and the authorization rules decide (401), exactly like the app filter.
 *
 * <p>Self-clears the thread-local after the request to avoid identity leaking across pooled
 * Tomcat threads.
 */
public class EdgeBearerAuthFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(EdgeBearerAuthFilter.class);
    private static final String BEARER_PREFIX = "Bearer ";
    private static final String XFAT_HEADER = "X-Forwarded-Access-Token";

    /**
     * Marker authority granted only here, so code downstream can tell a portal user
     * (verified Keycloak token, no row in Report Studio's own {@code User} table) apart
     * from an app-token user. {@code AuthController#me} uses it to answer instead of 401.
     */
    public static final String EDGE_AUTHORITY = "EDGE_AUTH";

    /**
     * Prefix for the caller's portal role codes, taken from the token's roles claim
     * ({@code edge.auth.roles-claim}, default {@code roles}). Kept apart
     * from Spring's own {@code ROLE_} space: these are not Report Studio authorities,
     * they are the portal's roles and only the registry visibility filter reads them.
     */
    public static final String PORTAL_ROLE_PREFIX = "PORTAL_ROLE_";

    private final JwtDecoder jwtDecoder;
    private final Set<String> acceptedAzp;
    private final String grantedRole;
    /** Name of the token claim that carries the caller's role codes (a JSON array of strings). */
    private final String rolesClaim;

    public EdgeBearerAuthFilter(JwtDecoder jwtDecoder, Set<String> acceptedAzp, String grantedRole) {
        this(jwtDecoder, acceptedAzp, grantedRole, "roles");
    }

    public EdgeBearerAuthFilter(JwtDecoder jwtDecoder, Set<String> acceptedAzp, String grantedRole, String rolesClaim) {
        this.jwtDecoder = jwtDecoder;
        this.acceptedAzp = acceptedAzp;
        this.grantedRole = grantedRole;
        this.rolesClaim = rolesClaim == null || rolesClaim.isBlank() ? "roles" : rolesClaim.trim();
    }

    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest req,
                                    @NonNull HttpServletResponse res,
                                    @NonNull FilterChain chain)
            throws ServletException, IOException {
        boolean setHere = false;
        if (SecurityContextHolder.getContext().getAuthentication() == null) {
            try {
                setHere = authenticate(req);
            } catch (Exception e) {
                // Never let an auth hiccup 500 the request — fall through unauthenticated.
                log.debug("[edge-auth] unexpected auth error: {}", e.toString());
            }
        }
        try {
            chain.doFilter(req, res);
        } finally {
            if (setHere) SecurityContextHolder.clearContext();
        }
    }

    /** @return true iff this call set the SecurityContext (so the caller clears it). */
    private boolean authenticate(HttpServletRequest req) {
        String token = extractToken(req);
        if (token == null) return false;

        final Jwt jwt;
        try {
            jwt = jwtDecoder.decode(token); // signature + issuer + expiry against Keycloak JWKS
        } catch (Exception e) {
            // Also the normal path for a Report Studio app token that reached here — not an error.
            log.debug("[edge-auth] token JWKS verify failed: {}", e.toString());
            return false;
        }

        String azp = jwt.getClaimAsString("azp");
        if (acceptedAzp != null && !acceptedAzp.isEmpty() && (azp == null || !acceptedAzp.contains(azp))) {
            log.info("[edge-auth] azp mismatch: azp={} accepted={}", azp, acceptedAzp);
            return false;
        }

        String sub = jwt.getSubject();
        if (sub == null || sub.isBlank()) {
            log.info("[edge-auth] token has no sub claim");
            return false;
        }

        List<SimpleGrantedAuthority> authorities = new ArrayList<>();
        authorities.add(new SimpleGrantedAuthority("ROLE_" + grantedRole));
        authorities.add(new SimpleGrantedAuthority(EDGE_AUTHORITY));
        for (String code : portalRoleCodes(jwt)) {
            authorities.add(new SimpleGrantedAuthority(PORTAL_ROLE_PREFIX + code));
        }

        var auth = new UsernamePasswordAuthenticationToken(
                usernameOf(jwt, sub), token, authorities);
        SecurityContext sc = SecurityContextHolder.createEmptyContext();
        sc.setAuthentication(auth);
        SecurityContextHolder.setContext(sc);
        log.debug("[edge-auth] authenticated sub={} azp={}", sub, azp);
        return true;
    }

    /** Role codes from the configured roles claim; empty when the claim is absent. */
    private List<String> portalRoleCodes(Jwt jwt) {
        Object claim = jwt.getClaim(rolesClaim);
        if (!(claim instanceof Collection<?> raw)) return List.of();
        List<String> codes = new ArrayList<>();
        for (Object o : raw) {
            if (o == null) continue;
            String s = o.toString().trim();
            if (!s.isEmpty()) codes.add(s);
        }
        return codes;
    }

    /**
     * The caller's portal role codes, or {@code null} when they did not come through the
     * portal — the registry visibility filter treats null as "no restriction", so a
     * direct {@code admin/admin} login is unaffected.
     */
    public static List<String> portalRolesOf(Authentication auth) {
        if (auth == null || !auth.isAuthenticated()) return null;
        boolean edge = auth.getAuthorities().stream()
                .anyMatch(a -> EDGE_AUTHORITY.equals(a.getAuthority()));
        if (!edge) return null;
        return auth.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .filter(a -> a.startsWith(PORTAL_ROLE_PREFIX))
                .map(a -> a.substring(PORTAL_ROLE_PREFIX.length()))
                .toList();
    }

    /** Readable identity for job.requestedBy / audit — falls back to the opaque sub. */
    private static String usernameOf(Jwt jwt, String sub) {
        String name = jwt.getClaimAsString("preferred_username");
        if (name == null || name.isBlank()) name = jwt.getClaimAsString("email");
        return (name == null || name.isBlank()) ? sub : name;
    }

    /** Prefer X-Forwarded-Access-Token (edge-injected); fall back to Authorization: Bearer. */
    private String extractToken(HttpServletRequest req) {
        String xfat = req.getHeader(XFAT_HEADER);
        if (xfat != null && !xfat.isBlank()) return xfat.trim();

        String header = req.getHeader(HttpHeaders.AUTHORIZATION);
        if (header != null && header.regionMatches(true, 0, BEARER_PREFIX, 0, BEARER_PREFIX.length())) {
            String t = header.substring(BEARER_PREFIX.length()).trim();
            if (!t.isEmpty()) return t;
        }
        return null;
    }
}
