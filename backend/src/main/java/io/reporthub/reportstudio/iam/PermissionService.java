package io.reporthub.reportstudio.iam;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Level 1: may the principal perform {@code action} on IAM object {@code code}? */
public final class PermissionService {

    private PermissionService() {}

    private static final String V = ObjectCatalog.VIEW, X = ObjectCatalog.EXECUTE;

    /** What a local (non-IAM) USER may do: view/run reports and data, no admin areas. */
    static final Map<String, Set<String>> LOCAL_USER = Map.ofEntries(
            Map.entry(ObjectCatalog.ROOT, Set.of(V)),
            Map.entry("RH.OVERVIEW", Set.of(V)),
            Map.entry("RH.REPORT", Set.of(V, X)),
            Map.entry("RH.REPORT.PARAMETER", Set.of(V)),
            Map.entry("RH.OUTPUT", Set.of(V, X)),
            Map.entry("RH.QUEUE", Set.of(V)),
            Map.entry("RH.REPOSITORY", Set.of(V, X)),
            Map.entry("RH.REPOSITORY.REGISTRY", Set.of(V)),
            Map.entry("RH.ADHOC", Set.of(V, X)),
            Map.entry("RH.DATASET", Set.of(V, X)),
            Map.entry("RH.DASHBOARD", Set.of(V)),
            Map.entry("RH.DOCUMENT", Set.of(V, X)));

    public static boolean can(RhPrincipal p, String code, String action) {
        if (p == null) return false;
        if (p.admin()) return true;
        Map<String, Set<String>> perms = p.objectPerms();
        if (perms == null) {
            // built-in (local) users: a fixed, non-admin set - exact object match, no inheritance
            Set<String> acts = LOCAL_USER.get(code);
            return acts != null && acts.contains(action);
        }
        // IAM: a grant on the object or on any ancestor (RH.REPORT covers RH.REPORT.PARAMETER)
        String c = code;
        while (c != null) {
            Set<String> acts = perms.get(c);
            if (acts != null && acts.contains(action)) return true;
            ObjectCatalog.Obj o = ObjectCatalog.find(c);
            c = o == null ? parentOf(c) : o.parent();
        }
        return false;
    }

    private static String parentOf(String code) {
        int i = code.lastIndexOf('.');
        return i < 0 ? null : code.substring(0, i);
    }

    /** Effective matrix over the whole catalog — what the frontend uses to hide menus/buttons. */
    public static Map<String, List<String>> matrix(RhPrincipal p) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        for (ObjectCatalog.Obj o : ObjectCatalog.OBJECTS) {
            // inheritance is already resolved per object here, so clients look objects up exactly
            List<String> acts = o.actions().stream().filter(a -> can(p, o.code(), a)).toList();
            if (!acts.isEmpty()) out.put(o.code(), acts);
        }
        return out;
    }
}
