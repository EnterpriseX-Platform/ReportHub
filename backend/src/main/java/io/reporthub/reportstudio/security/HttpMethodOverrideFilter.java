package io.reporthub.reportstudio.security;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.Set;

/**
 * Tunnels {@code PUT}/{@code PATCH}/{@code DELETE} through {@code POST} via the
 * {@code X-HTTP-Method-Override} header.
 *
 * <p>Why: the UAT edge (Cloudflare) runs a "restricted HTTP methods" WAF rule that
 * blocks {@code PUT}/{@code PATCH}/{@code DELETE} outright with a 403 block page — they
 * never reach the app (confirmed 2026-06-15: GET/POST pass, PUT/PATCH/DELETE → 403).
 * The SPA therefore sends those writes as {@code POST} carrying the override header, and
 * this filter restores the real method here.
 *
 * <p>Ordering is critical: it runs at {@link Ordered#HIGHEST_PRECEDENCE}, BEFORE the Spring
 * Security filter chain, so the per-method authorization rules in
 * {@link SecurityConfig} (e.g. {@code PUT/DELETE /reports/** → ADMIN}) still see the real
 * method. Restoring the method only after security would let a POST to the run endpoint
 * (allowed for any signed-in user) smuggle a {@code DELETE} — a privilege escalation.
 *
 * <p>No-op for everything else: native PUT/DELETE (e.g. from SIT, which has no such WAF, or
 * any non-browser client) still work unchanged, since the filter only acts on a {@code POST}
 * that carries the header with an allowed override value.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class HttpMethodOverrideFilter implements Filter {

    /** Header the SPA sets on a tunnelled write. */
    public static final String HEADER = "X-HTTP-Method-Override";

    /** Only safe to override into these — never GET/POST/HEAD/OPTIONS. */
    private static final Set<String> ALLOWED = Set.of("PUT", "PATCH", "DELETE");

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        if (request instanceof HttpServletRequest http && "POST".equalsIgnoreCase(http.getMethod())) {
            String override = http.getHeader(HEADER);
            if (override != null) {
                String method = override.trim().toUpperCase();
                if (ALLOWED.contains(method)) {
                    chain.doFilter(new HttpServletRequestWrapper(http) {
                        @Override
                        public String getMethod() {
                            return method;
                        }
                    }, response);
                    return;
                }
            }
        }
        chain.doFilter(request, response);
    }
}
