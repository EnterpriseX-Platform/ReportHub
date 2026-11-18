package io.reporthub.reportstudio.acl;

import io.reporthub.reportstudio.iam.RhPrincipal;

import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Pure ACL evaluation (unit-tested). */
public final class AclRules {

    public static final List<String> TYPES = List.of("REPORT", "DATASOURCE", "DATASET", "REPO_TABLE", "DASHBOARD", "OUTPUT", "DOCUMENT");
    public static final List<String> PERMISSIONS = List.of("view", "run", "edit");
    public static final Set<String> PRINCIPAL_TYPES = Set.of("role", "responsibility", "user");

    public record Grant(String principalType, String principalCode, String permission) {}

    private AclRules() {}

    public static int rank(String perm) {
        int i = PERMISSIONS.indexOf(perm == null ? "" : perm.toLowerCase(Locale.ROOT));
        if (i < 0) throw new IllegalArgumentException("Unknown permission: " + perm);
        return i;
    }

    public static boolean matches(Grant g, RhPrincipal p) {
        return switch (g.principalType().toLowerCase(Locale.ROOT)) {
            case "role" -> p.roles().contains(g.principalCode());
            case "responsibility" -> p.responsibilities().contains(g.principalCode());
            case "user" -> p.username().equals(g.principalCode());
            default -> false;
        };
    }

    /** Admin → yes; no grants → open; else a matching grant at or above {@code perm}. */
    public static boolean allowed(Collection<Grant> grants, RhPrincipal p, String perm) {
        if (p == null) return false;
        if (p.admin()) return true;
        if (grants == null || grants.isEmpty()) return true;
        int need = rank(perm);
        for (Grant g : grants) {
            if (rank(g.permission()) >= need && matches(g, p)) return true;
        }
        return false;
    }

    /** Permissions at or above {@code perm} (for query predicates). */
    public static List<String> atLeast(String perm) {
        return PERMISSIONS.subList(rank(perm), PERMISSIONS.size());
    }
}
