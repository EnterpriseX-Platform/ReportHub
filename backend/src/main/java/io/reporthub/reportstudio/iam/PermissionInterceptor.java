package io.reporthub.reportstudio.iam;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Level 1 enforcement: every handled request is checked against {@link EndpointPolicy}.
 * Anonymous requests are left to the security filter chain (public paths stay public).
 */
@Configuration
public class PermissionInterceptor implements HandlerInterceptor, WebMvcConfigurer {

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(this);
    }

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        if ("OPTIONS".equals(req.getMethod())) return true;
        RhPrincipal p = CurrentPrincipal.get().orElse(null);
        if (p == null) return true;
        String path = pathOf(req);
        if (path.startsWith("/public/")) return true;
        EndpointPolicy.Rule rule = EndpointPolicy.match(req.getMethod(), path);
        if (!EndpointPolicy.allows(rule, req.getMethod(), p)) {
            EndpointPolicy.Req first = rule.anyOf().get(0);
            if (EndpointPolicy.ADMIN_ONLY.equals(first.code())) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "ReportHub administrators only");
            }
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "Missing permission " + EndpointPolicy.resolveAction(first.action(), req.getMethod()) + " on " + first.code());
        }
        return true;
    }

    static String pathOf(HttpServletRequest req) {
        String uri = req.getRequestURI();
        String ctx = req.getContextPath();
        String p = (ctx != null && !ctx.isEmpty() && uri.startsWith(ctx)) ? uri.substring(ctx.length()) : uri;
        return p.isEmpty() ? "/" : p;
    }
}
