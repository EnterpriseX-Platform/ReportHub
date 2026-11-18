package io.reporthub.reportstudio.iam;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.LinkedHashMap;

/**
 * The IAM object codes ReportHub checks (level 1: menus, screens and actions).
 * Exported by {@code GET /iam/objects/export} so an admin can import them into the IAM service.
 */
public final class ObjectCatalog {

    public static final String VIEW = "view", CREATE = "create", UPDATE = "update",
            DELETE = "delete", EXECUTE = "execute", APPROVE = "approve";

    public static final List<String> ALL_ACTIONS = List.of(VIEW, CREATE, UPDATE, DELETE, EXECUTE, APPROVE);
    private static final List<String> CRUDX = List.of(VIEW, CREATE, UPDATE, DELETE, EXECUTE);
    private static final List<String> CRUD = List.of(VIEW, CREATE, UPDATE, DELETE);

    public record Obj(String code, String name, String type, String parent, String route, List<String> actions) {}

    public static final String ROOT = "RH";

    public static final List<Obj> OBJECTS = List.of(
            new Obj(ROOT, "ReportHub", "menu", null, null, List.of(VIEW)),
            new Obj("RH.OVERVIEW", "Overview", "page", ROOT, "/", List.of(VIEW)),
            new Obj("RH.REPORT", "Report Registry", "page", ROOT, "/registry", CRUDX),
            new Obj("RH.REPORT.PARAMETER", "Parameters", "page", "RH.REPORT", "/parameters", CRUD),
            new Obj("RH.OUTPUT", "Output Files", "page", ROOT, "/outputs", List.of(VIEW, DELETE, EXECUTE, APPROVE)),
            new Obj("RH.QUEUE", "Queue Monitor", "page", ROOT, "/queue", List.of(VIEW, EXECUTE)),
            new Obj("RH.INTEGRATION", "Integrations", "page", ROOT, "/integrations", List.of(VIEW, UPDATE, EXECUTE)),
            new Obj("RH.DATASOURCE", "Database connections", "button", "RH.INTEGRATION", "/integrations?category=databases", CRUDX),
            new Obj("RH.REPOSITORY", "Tables", "page", ROOT, "/repository", CRUDX),
            new Obj("RH.REPOSITORY.REGISTRY", "Table registry and folders", "button", "RH.REPOSITORY", null, CRUD),
            new Obj("RH.ADHOC", "Ad-hoc Report", "page", ROOT, "/adhocreport", CRUDX),
            new Obj("RH.DATASET", "Datasets", "page", ROOT, "/datasets", CRUDX),
            new Obj("RH.PIPELINE", "Data Pipeline", "page", ROOT, "/datapipeline", CRUDX),
            new Obj("RH.CHAIN", "Job Chains", "page", "RH.PIPELINE", "/chains", CRUDX),
            new Obj("RH.CHECK", "Data Checks", "page", ROOT, "/checks", CRUDX),
            new Obj("RH.SCHEDULER", "Scheduled SQL", "page", ROOT, "/schedulers", CRUDX),
            new Obj("RH.DASHBOARD", "Dashboards", "page", ROOT, "/dashboards", CRUD),
            new Obj("RH.DOCUMENT", "Documents", "page", ROOT, "/documents", CRUDX),
            new Obj("RH.ENGINE", "Report engines", "button", "RH.INTEGRATION", "/integrations?category=engines", CRUDX),
            new Obj("RH.RESOURCE", "Shared resources", "button", "RH.SETTINGS", null, List.of(VIEW, CREATE, DELETE)),
            new Obj("RH.SETTINGS", "Settings", "page", ROOT, "/settings", List.of(VIEW, UPDATE)),
            new Obj("RH.ACCESS", "Access rules (object ACL and row filters)", "button", "RH.SETTINGS", null, List.of(VIEW, UPDATE)));

    /** Objects a non-admin built-in (local/edge) user may only view. */
    static final Set<String> ADMIN_OBJECTS = Set.of("RH.SETTINGS", "RH.ACCESS", "RH.ENGINE", "RH.RESOURCE", "RH.INTEGRATION");

    private ObjectCatalog() {}

    public static Obj find(String code) {
        return OBJECTS.stream().filter(o -> o.code().equals(code)).findFirst().orElse(null);
    }

    /** Import document for the IAM service (object tree + action → permission flag mapping). */
    public static Map<String, Object> exportDocument(String appCode) {
        Map<String, Object> doc = new LinkedHashMap<>();
        doc.put("application", Map.of("code", appCode, "name", "ReportHub"));
        doc.put("module", Map.of("code", ROOT, "name", "ReportHub"));
        doc.put("actionFlags", IamClient.ACTION_FLAGS);
        doc.put("objects", OBJECTS.stream().map(o -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("code", o.code());
            m.put("name", o.name());
            m.put("objectType", o.type());
            m.put("parentCode", o.parent());
            m.put("route", o.route());
            m.put("actions", o.actions());
            m.put("permissionFlags", o.actions().stream().map(IamClient.ACTION_FLAGS::get).toList());
            return m;
        }).toList());
        return doc;
    }
}
