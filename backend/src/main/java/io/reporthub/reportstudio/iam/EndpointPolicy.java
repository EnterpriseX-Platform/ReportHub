package io.reporthub.reportstudio.iam;

import org.springframework.util.AntPathMatcher;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static io.reporthub.reportstudio.iam.ObjectCatalog.*;

/**
 * Maps every API endpoint (method + servlet path) to the IAM object/action it needs.
 * First matching rule wins. {@code AUTO} derives the action from the HTTP method
 * (GET→view, POST→create, PUT/PATCH→update, DELETE→delete). A rule with no requirement
 * ({@link #open}) means "any signed-in user" (lookups other screens need).
 * Paths not covered here only require authentication.
 */
public final class EndpointPolicy {

    public static final String AUTO = "auto";
    /** Pseudo object: only {@link RhPrincipal#admin()} callers pass. */
    public static final String ADMIN_ONLY = "RH#ADMIN";

    public record Req(String code, String action) {}

    public record Rule(Set<String> methods, String pattern, List<Req> anyOf) {}

    private static final AntPathMatcher M = new AntPathMatcher();
    private static final List<Rule> RULES = new ArrayList<>();

    private static void r(String methods, String pattern, String... codeActionPairs) {
        List<Req> reqs = new ArrayList<>();
        for (int i = 0; i < codeActionPairs.length; i += 2) reqs.add(new Req(codeActionPairs[i], codeActionPairs[i + 1]));
        RULES.add(new Rule(methods.equals("*") ? Set.of() : Set.of(methods.split(",")), pattern, reqs));
    }

    private static void open(String methods, String pattern) { r(methods, pattern); }

    static {
        // --- platform / identity
        open("*", "/auth/**");
        open("GET", "/tenancy/mine");
        r("*", "/tenancy/**", "RH.SETTINGS", "auto-settings");
        r("*", "/settings/**", "RH.SETTINGS", "auto-settings");
        r("GET", "/iam/**", "RH.SETTINGS", VIEW);
        r("*", "/iam/**", "RH.SETTINGS", UPDATE);
        // Local user accounts: ReportHub admins only (never governed by an IAM grant).
        r("*", "/users/**", ADMIN_ONLY, "admin");
        r("*", "/users", ADMIN_ONLY, "admin");
        r("GET", "/acl/**", "RH.ACCESS", VIEW);
        r("*", "/acl/**", "RH.ACCESS", UPDATE);
        r("GET", "/row-filters/**", "RH.ACCESS", VIEW);
        r("POST", "/row-filters/*/*/preview", "RH.ACCESS", VIEW);
        r("*", "/row-filters/**", "RH.ACCESS", UPDATE);
        open("GET", "/resources/**");
        r("*", "/resources/**", "RH.RESOURCE", AUTO);
        open("GET", "/engines");
        r("POST", "/engines/*/test", "RH.ENGINE", EXECUTE);
        r("POST", "/engines/plugins/reload", "RH.ENGINE", UPDATE);
        r("*", "/engines/**", "RH.ENGINE", AUTO);
        r("GET", "/dashboard/**", "RH.OVERVIEW", VIEW);

        // --- reports
        r("POST", "/reports/*/run", "RH.REPORT", EXECUTE);
        r("GET", "/reports/*/delivery", "RH.REPORT", VIEW);
        r("PUT", "/reports/*/delivery", "RH.REPORT", UPDATE);
        r("GET", "/reports/*/parameters", "RH.REPORT", VIEW, "RH.REPORT.PARAMETER", VIEW);
        r("PUT", "/reports/*/parameters", "RH.REPORT.PARAMETER", UPDATE, "RH.REPORT", UPDATE);
        r("POST", "/reports", "RH.REPORT", CREATE);
        r("POST", "/reports/**", "RH.REPORT", UPDATE);
        r("*", "/reports/**", "RH.REPORT", AUTO);
        open("GET", "/categories");
        r("*", "/categories/**", "RH.REPORT", UPDATE);
        open("GET", "/parameters/**");
        r("POST", "/parameters/preview-options", "RH.REPORT.PARAMETER", VIEW);
        r("*", "/parameters/**", "RH.REPORT.PARAMETER", AUTO);

        // --- outputs and queue
        r("POST", "/outputs/filehub/**", "RH.OUTPUT", EXECUTE);
        r("POST", "/outputs/filehub", "RH.OUTPUT", EXECUTE);
        r("*", "/outputs/confirm", "RH.OUTPUT", APPROVE);
        r("*", "/outputs/share/**", "RH.OUTPUT", EXECUTE);
        r("*", "/outputs/share", "RH.OUTPUT", EXECUTE);
        r("*", "/outputs/**", "RH.OUTPUT", AUTO);
        r("GET", "/jobs/*/output/download", "RH.OUTPUT", VIEW, "RH.REPORT", EXECUTE);
        r("POST", "/jobs/*/retry", "RH.QUEUE", EXECUTE, "RH.REPORT", EXECUTE);
        r("POST", "/jobs/*/cancel", "RH.QUEUE", EXECUTE, "RH.REPORT", EXECUTE);
        r("GET", "/jobs/**", "RH.QUEUE", VIEW, "RH.REPORT", EXECUTE);
        r("GET", "/jobs", "RH.QUEUE", VIEW, "RH.REPORT", EXECUTE);
        r("GET", "/queue/**", "RH.QUEUE", VIEW);

        // --- integrations (writes are additionally checked for ReportHub admin in the controller)
        open("GET", "/integrations/targets/**");
        r("GET", "/integrations/**", "RH.INTEGRATION", VIEW);
        r("GET", "/integrations", "RH.INTEGRATION", VIEW);
        r("POST", "/integrations/*/test", "RH.INTEGRATION", EXECUTE);
        r("*", "/integrations/**", ADMIN_ONLY, "admin");
        r("*", "/integrations", ADMIN_ONLY, "admin");

        // --- data
        r("POST", "/documents/*/filehub", "RH.DOCUMENT", EXECUTE);
        open("GET", "/datasources");
        r("POST", "/datasources/*/test", "RH.DATASOURCE", EXECUTE);
        r("POST", "/datasources/*/default", "RH.DATASOURCE", UPDATE);
        r("*", "/datasources/**", "RH.DATASOURCE", AUTO);
        open("GET", "/repository/registry/**");
        open("GET", "/repository/folders/**");
        r("*", "/repository/registry/**", "RH.REPOSITORY.REGISTRY", AUTO);
        r("*", "/repository/folders/**", "RH.REPOSITORY.REGISTRY", AUTO);
        r("POST", "/repository/tables/*/rows", "RH.REPOSITORY", CREATE);
        r("POST", "/repository/tables/*/rows/update", "RH.REPOSITORY", UPDATE);
        r("POST", "/repository/tables/*/rows/delete", "RH.REPOSITORY", DELETE);
        r("GET", "/repository/execute/**", "RH.ADHOC", VIEW, "RH.REPOSITORY", EXECUTE);
        r("POST", "/repository/execute/**", "RH.ADHOC", EXECUTE, "RH.REPOSITORY", EXECUTE);
        r("POST", "/repository/**", "RH.REPOSITORY", EXECUTE);
        r("*", "/repository/**", "RH.REPOSITORY", AUTO);
        r("GET", "/analytics/**", "RH.ADHOC", VIEW, "RH.DASHBOARD", VIEW);
        r("*", "/analytics/**", "RH.ADHOC", EXECUTE);
        r("GET", "/adhoc/**", "RH.ADHOC", VIEW);
        r("*", "/adhoc/**", "RH.ADHOC", EXECUTE);
        r("POST", "/views", "RH.ADHOC", CREATE);
        r("POST", "/views/**", "RH.ADHOC", UPDATE);
        r("*", "/views/**", "RH.ADHOC", AUTO);
        r("*", "/workspaces/**", "RH.ADHOC", AUTO);
        r("GET", "/datasets/**", "RH.DATASET", VIEW, "RH.ADHOC", VIEW, "RH.DASHBOARD", VIEW);
        r("GET", "/datasets", "RH.DATASET", VIEW, "RH.ADHOC", VIEW, "RH.DASHBOARD", VIEW);
        r("POST", "/datasets", "RH.DATASET", CREATE);
        r("POST", "/datasets/preview", "RH.DATASET", EXECUTE);
        r("POST", "/datasets/*/aggregate", "RH.DATASET", EXECUTE, "RH.ADHOC", EXECUTE, "RH.DASHBOARD", VIEW);
        r("POST", "/datasets/*/export", "RH.DATASET", EXECUTE, "RH.ADHOC", EXECUTE);
        r("*", "/datasets/*/capture", "RH.DATASET", EXECUTE);
        r("*", "/datasets/**", "RH.DATASET", AUTO);

        // --- build & run
        r("POST", "/warehouse/pipelines", "RH.PIPELINE", CREATE);
        r("POST", "/warehouse/pipelines/*/toggle", "RH.PIPELINE", UPDATE);
        r("POST", "/warehouse/**", "RH.PIPELINE", EXECUTE);
        r("*", "/warehouse/**", "RH.PIPELINE", AUTO);
        r("POST", "/etl-chains", "RH.CHAIN", CREATE);
        r("POST", "/etl-chains/**", "RH.CHAIN", EXECUTE);
        r("*", "/etl-chains/**", "RH.CHAIN", AUTO);
        r("POST", "/checks", "RH.CHECK", CREATE);
        r("POST", "/checks/*/run", "RH.CHECK", EXECUTE);
        r("POST", "/checks/**/run", "RH.CHECK", EXECUTE);
        r("POST", "/checks/findings/export", "RH.CHECK", VIEW);
        r("POST", "/checks/**", "RH.CHECK", UPDATE);
        r("*", "/checks/**", "RH.CHECK", AUTO);
        r("*", "/checks", "RH.CHECK", AUTO);
        r("POST", "/schedulers", "RH.SCHEDULER", CREATE);
        r("POST", "/schedulers/*/run", "RH.SCHEDULER", EXECUTE);
        r("POST", "/schedulers/**", "RH.SCHEDULER", UPDATE);
        r("*", "/schedulers/**", "RH.SCHEDULER", AUTO);
        r("POST", "/dashboards", "RH.DASHBOARD", CREATE);
        r("POST", "/dashboards/**", "RH.DASHBOARD", UPDATE);
        r("*", "/dashboards/**", "RH.DASHBOARD", AUTO);

        // --- documents (the print page reads /public/documents/** with a signed print token)
        r("POST", "/documents", "RH.DOCUMENT", CREATE);
        r("POST", "/documents/data", "RH.DOCUMENT", VIEW);
        r("POST", "/documents/*/data", "RH.DOCUMENT", VIEW);
        r("POST", "/documents/*/pdf", "RH.DOCUMENT", EXECUTE);
        r("POST", "/documents/*/copy", "RH.DOCUMENT", CREATE);
        r("POST", "/documents/*/assets", "RH.DOCUMENT", UPDATE);
        r("*", "/documents/**", "RH.DOCUMENT", AUTO);
    }

    private EndpointPolicy() {}

    /** Requirement for a request; {@code null} = not covered (authentication only). */
    public static Rule match(String method, String path) {
        for (Rule rule : RULES) {
            if (!rule.methods().isEmpty() && !rule.methods().contains(method)) continue;
            if (M.match(rule.pattern(), path)) return rule;
        }
        return null;
    }

    public static String resolveAction(String action, String method) {
        if ("auto-settings".equals(action)) return "GET".equals(method) ? VIEW : UPDATE;
        if (!AUTO.equals(action)) return action;
        return switch (method) {
            case "GET", "HEAD" -> VIEW;
            case "POST" -> CREATE;
            case "PUT", "PATCH" -> UPDATE;
            case "DELETE" -> DELETE;
            default -> VIEW;
        };
    }

    /** True when the principal satisfies the rule (any alternative), or the rule is open. */
    public static boolean allows(Rule rule, String method, RhPrincipal p) {
        if (rule == null || rule.anyOf().isEmpty()) return true;
        for (Req q : rule.anyOf()) {
            if (ADMIN_ONLY.equals(q.code())) { if (p != null && p.admin()) return true; continue; }
            if (PermissionService.can(p, q.code(), resolveAction(q.action(), method))) return true;
        }
        return false;
    }

    public static List<Rule> rules() { return List.copyOf(RULES); }
}
