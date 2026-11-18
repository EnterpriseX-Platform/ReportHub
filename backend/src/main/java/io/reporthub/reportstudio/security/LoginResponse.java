package io.reporthub.reportstudio.security;

/** Successful-login response: signed JWT plus display metadata. */
public record LoginResponse(
        String token,
        String role,
        String displayName) {
}
