package io.reporthub.reportstudio.security;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

/**
 * Application user for JWT login + RBAC.
 *
 * <p>Backed by table {@code app_user} (seeded by Flyway V5). Roles are bare names
 * ({@code ADMIN} / {@code USER}); Spring Security authorities are derived as
 * {@code ROLE_<role>} in {@link JwtAuthenticationFilter}.
 */
@Entity
@Table(name = "app_user")
@Getter
@Setter
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String username;

    @Column(name = "password_hash", nullable = false)
    private String passwordHash;

    @Column(nullable = false)
    private String role;

    @Column(name = "display_name")
    private String displayName;
}
