package io.reporthub.reportstudio.security;

/** Identity of the current bearer for {@code GET /auth/me}. */
public record MeResponse(
        String username,
        String role,
        String displayName) {
}
