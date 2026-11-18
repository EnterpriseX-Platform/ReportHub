package io.reporthub.reportstudio.iam;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.lang.NonNull;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * {@code app.auth.mode=iam}: accepts an IAM bearer token (or IAM's {@code token} cookie) that
 * the app's own JWT filter did not recognise, and authenticates it through
 * {@link IamPrincipalService}. Invalid tokens leave the request anonymous (→ 401 on protected paths).
 */
public class IamBearerAuthFilter extends OncePerRequestFilter {

    private final IamPrincipalService iam;

    public IamBearerAuthFilter(IamPrincipalService iam) {
        this.iam = iam;
    }

    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest req, @NonNull HttpServletResponse res,
                                    @NonNull FilterChain chain) throws ServletException, IOException {
        if (SecurityContextHolder.getContext().getAuthentication() == null) {
            String token = tokenOf(req);
            if (token != null) {
                try {
                    RhPrincipal p = iam.resolve(token);
                    SecurityContextHolder.getContext().setAuthentication(new RhAuthentication(p, token, List.of()));
                } catch (IamException e) {
                    if (e.status() == 0 || e.status() >= 500) {
                        // IAM down is not "bad credentials": answer 503 so clients retry instead of logging out.
                        org.slf4j.LoggerFactory.getLogger(IamBearerAuthFilter.class)
                                .warn("IAM unavailable while validating a token: {}", e.getMessage());
                        res.setStatus(503);
                        res.setContentType("application/json");
                        res.getWriter().write("{\"status\":503,\"error\":\"Service Unavailable\",\"message\":\"Identity service is unavailable; please retry.\"}");
                        return;
                    }
                    if (e.status() == 403) {
                        res.setStatus(403);
                        res.setContentType("application/json");
                        res.getWriter().write("{\"status\":403,\"error\":\"Forbidden\",\"message\":\"" + e.getMessage().replace("\"", "'") + "\"}");
                        return;
                    }
                    // otherwise: stay anonymous (401 later)
                }
            }
        }
        chain.doFilter(req, res);
    }

    static String tokenOf(HttpServletRequest req) {
        String h = req.getHeader("Authorization");
        if (h != null && h.regionMatches(true, 0, "Bearer ", 0, 7)) {
            String t = h.substring(7).trim();
            return t.isEmpty() ? null : t;
        }
        if (req.getCookies() != null) {
            for (var c : req.getCookies()) if ("token".equals(c.getName()) && !c.getValue().isBlank()) return c.getValue();
        }
        return null;
    }
}
