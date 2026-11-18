package io.reporthub.reportstudio.integration;

import java.util.List;

/** Connector types and the category each one is listed under on the Integrations screen. */
public final class ConnectorTypes {
    public static final String DATABASE = "database";
    public static final String IAM = "iam";
    public static final String FILEHUB = "filehub";
    public static final String OBJECT_STORE = "object-store";
    public static final String EXPORTER = "exporter";
    public static final String NOTIFY = "notify";
    /** Report engines (engine_instance table + built-in engines); managed by /engines. */
    public static final String ENGINE = "engine";

    /** Fixed ids of singleton connectors. */
    public static final String IAM_ID = "iam";
    public static final String NOTIFY_ID = "notify";
    public static final String OBJECT_STORE_ID = "object-store";
    public static final String EXPORTER_ID = "exporter";

    public record Category(String key, String label, List<String> types) {}

    public static final List<Category> CATEGORIES = List.of(
            new Category("databases", "Databases", List.of(DATABASE)),
            new Category("identity", "Identity", List.of(IAM)),
            new Category("storage", "File storage", List.of(OBJECT_STORE, FILEHUB)),
            new Category("engines", "Report engines", List.of(ENGINE)),
            new Category("exporter", "Document exporter", List.of(EXPORTER)),
            new Category("notifications", "Notifications", List.of(NOTIFY)));

    private ConnectorTypes() {}
}
