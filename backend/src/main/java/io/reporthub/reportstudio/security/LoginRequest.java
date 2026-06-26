package io.reporthub.reportstudio.security;

import jakarta.validation.constraints.NotBlank;

/** Login payload for {@code POST /auth/login}. */
public record LoginRequest(
        @NotBlank String username,
        @NotBlank String password) {
}
