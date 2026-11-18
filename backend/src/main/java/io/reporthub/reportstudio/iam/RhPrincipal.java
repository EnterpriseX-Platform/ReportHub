package io.reporthub.reportstudio.iam;

import java.util.Map;
import java.util.Set;

/**
 * Who is calling, independent of how they signed in.
 *
 * @param source        {@code local} (built-in users), {@code iam} (IAM service) or {@code edge} (gateway token)
 * @param tenantId      ReportHub tenant id the caller belongs to
 * @param admin         bypasses object ACLs and row filters
 * @param roles         role codes (IAM role codes, or portal role codes for edge callers)
 * @param responsibilities IAM responsibility codes
 * @param attributes    user attributes usable in row-filter expressions ({@code departmentCode}, ...)
 * @param objectPerms   object code → granted actions; {@code null} = built-in defaults (local/edge)
 */
public record RhPrincipal(
        String username,
        String displayName,
        String source,
        String tenantId,
        boolean admin,
        Set<String> roles,
        Set<String> responsibilities,
        Map<String, String> attributes,
        Map<String, Set<String>> objectPerms) {

    public RhPrincipal {
        roles = roles == null ? Set.of() : Set.copyOf(roles);
        responsibilities = responsibilities == null ? Set.of() : Set.copyOf(responsibilities);
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
        objectPerms = objectPerms == null ? null : Map.copyOf(objectPerms);
    }

    /** Attribute lookup for row-filter expressions: {@code username}, {@code tenant}, then claims. */
    public String attribute(String name) {
        return switch (name) {
            case "username" -> username;
            case "tenant", "tenantId" -> tenantId;
            default -> attributes.get(name);
        };
    }
}
