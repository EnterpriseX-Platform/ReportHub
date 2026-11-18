package io.reporthub.reportstudio.security;

import java.util.List;
import java.util.Map;

/** Identity of the current bearer for {@code GET /auth/me}. */
public record MeResponse(
        String username,
        String role,
        String displayName,
        /**
         * Identity-provider role codes when the caller came through the portal, else empty.
         * The registry list is filtered against these, so surfacing them here is what
         * makes "why can this user not see report X" answerable from the browser.
         */
        List<String> portalRoles,
        /** {@code local} | {@code iam} | {@code edge} */
        String source,
        String tenant,
        boolean admin,
        List<String> roles,
        List<String> responsibilities,
        Map<String, String> attributes,
        /** Level-1 matrix: IAM object code → granted actions. Drives menu/button visibility. */
        Map<String, List<String>> permissions,
        String authMode) {

    public MeResponse(String username, String role, String displayName) {
        this(username, role, displayName, List.of());
    }

    public MeResponse(String username, String role, String displayName, List<String> portalRoles) {
        this(username, role, displayName, portalRoles, "local", "default", "ADMIN".equals(role),
                List.of(), List.of(), Map.of(), Map.of(), "local");
    }
}
