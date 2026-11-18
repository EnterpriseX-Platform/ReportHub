package io.reporthub.reportstudio.acl;

import io.reporthub.reportstudio.iam.CurrentPrincipal;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Configuration;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Level-2 enforcement on id-addressed endpoints: reading an object needs {@code view}, running /
 * querying / exporting it needs {@code run}, changing or deleting it needs {@code edit}.
 * List endpoints are filtered in their controllers.
 */
@Configuration
public class AclInterceptor implements HandlerInterceptor, WebMvcConfigurer {

    private record Rule(String pattern, String type, String var, Set<String> runSuffixes) {}

    private static final AntPathMatcher M = new AntPathMatcher();

    private static final List<Rule> RULES = List.of(
            new Rule("/datasets/{id}/**", "DATASET", "id", Set.of("aggregate", "export", "distinct")),
            new Rule("/datasets/{id}", "DATASET", "id", Set.of()),
            new Rule("/datasources/{id}/**", "DATASOURCE", "id", Set.of("test")),
            new Rule("/datasources/{id}", "DATASOURCE", "id", Set.of()),
            new Rule("/dashboards/{id}/**", "DASHBOARD", "id", Set.of("data")),
            new Rule("/dashboards/{id}", "DASHBOARD", "id", Set.of()),
            new Rule("/documents/{id}/**", "DOCUMENT", "id", Set.of("data", "pdf")),
            new Rule("/documents/{id}", "DOCUMENT", "id", Set.of()),
            new Rule("/repository/registry/{id}", "REPO_TABLE", "id", Set.of()),
            new Rule("/reports/{code}/**", "REPORT", "code", Set.of("run")),
            new Rule("/reports/{code}", "REPORT", "code", Set.of()));

    private static final Set<String> NOT_IDS = Set.of("codes", "preview", "reorder", "plugins", "data");

    private final AclService acl;

    public AclInterceptor(AclService acl) {
        this.acl = acl;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(this);
    }

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        if ("OPTIONS".equals(req.getMethod()) || CurrentPrincipal.get().isEmpty()) return true;
        String path = req.getRequestURI().substring(req.getContextPath() == null ? 0 : req.getContextPath().length());
        String[] need = requirement(req.getMethod(), path);
        if (need != null) acl.require(need[0], need[1], need[2]);
        return true;
    }

    /** {type, id, permission} for a request, or null when it does not address one object. */
    static String[] requirement(String method, String path) {
        for (Rule r : RULES) {
            if (!M.match(r.pattern(), path)) continue;
            Map<String, String> vars = M.extractUriTemplateVariables(r.pattern(), path);
            String id = vars.get(r.var());
            if (id == null || NOT_IDS.contains(id)) return null;
            String last = path.substring(path.lastIndexOf('/') + 1);
            String perm;
            if (r.runSuffixes().contains(last)) perm = "run";
            else if ("GET".equals(method) || "HEAD".equals(method)) perm = "view";
            else perm = "edit";
            return new String[]{r.type(), id, perm};
        }
        return null;
    }
}
