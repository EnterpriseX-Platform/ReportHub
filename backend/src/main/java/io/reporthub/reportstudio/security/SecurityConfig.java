package io.reporthub.reportstudio.security;

import jakarta.servlet.DispatcherType;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.Arrays;
import java.util.List;

/**
 * Spring Security 6 filter chain for Report Studio.
 *
 * <p>Policy:
 * <ul>
 *   <li>Stateless (no session), CSRF disabled, CORS enabled for the Next.js frontend.</li>
 *   <li>Public: every {@code GET}, all {@code OPTIONS} preflights, {@code /auth/**},
 *       {@code /actuator/**}.</li>
 *   <li>Authenticated: any other write ({@code POST}/{@code PUT}/{@code PATCH}/{@code DELETE}).</li>
 *   <li>{@code ADMIN} only: {@code POST}/{@code PUT}/{@code DELETE} under {@code /reports/**}.</li>
 * </ul>
 *
 * <p>Paths are matched against the servlet path (i.e. after the {@code /api}
 * context-path is stripped), so rules use {@code /reports/**}, not {@code /api/reports/**}.
 *
 * <p>The {@link JwtAuthenticationFilter} only <em>populates</em> the security context when a
 * valid bearer token is present; it never rejects anonymous requests, so public GETs keep working.
 */
@Configuration
public class SecurityConfig {

    private final List<String> allowedOrigins;

    public SecurityConfig(@Value("${app.cors.allowed-origins}") String origins) {
        this.allowedOrigins = Arrays.stream(origins.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();
    }

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http,
                                                   JwtAuthenticationFilter jwtFilter) throws Exception {
        http
                .cors(cors -> cors.configurationSource(corsConfigurationSource()))
                .csrf(AbstractHttpConfigurer::disable)
                .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                // Unauthenticated → 401 (so the SPA can route to /login); role denials stay 403.
                .exceptionHandling(e -> e.authenticationEntryPoint(
                        new org.springframework.security.web.authentication.HttpStatusEntryPoint(
                                org.springframework.http.HttpStatus.UNAUTHORIZED)))
                .authorizeHttpRequests(auth -> auth
                        // Let the ERROR/ASYNC dispatch through — otherwise a 500 forwarded to /error
                        // is re-evaluated here and masked as a 403.
                        .dispatcherTypeMatchers(DispatcherType.ERROR, DispatcherType.ASYNC).permitAll()
                        // Preflight — always allow.
                        .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                        // Public surface: login + health only. Everything else needs a token.
                        .requestMatchers("/auth/login").permitAll()
                        // Publicly shared dashboards (token URL) — no account needed to view.
                        .requestMatchers("/public/**").permitAll()
                        .requestMatchers("/actuator/**").permitAll()
                        .requestMatchers("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                        // Running a report is for any signed-in user (must precede the ADMIN write rules).
                        .requestMatchers(HttpMethod.POST, "/reports/*/run").authenticated()
                        // Uploading unit templates/subreports is for any signed-in user (config helpers
                        // like Tawan are not ADMIN). Must precede the ADMIN write rule below.
                        .requestMatchers(HttpMethod.POST,
                                "/reports/*/units/*/files", "/reports/*/units/*/files/base64").authenticated()
                        // Admin surface: user management + writes on the platform objects.
                        .requestMatchers("/users/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.POST, "/reports/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.PUT, "/reports/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.DELETE, "/reports/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.POST, "/engines/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.PUT, "/engines/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.DELETE, "/engines/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.POST, "/parameters/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.PUT, "/parameters/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.DELETE, "/parameters/**").hasRole("ADMIN")
                        // Shared resources (logos/images/fonts): readable by any user (the renderer
                        // and pickers need them); only ADMIN may upload/delete via the Settings page.
                        .requestMatchers(HttpMethod.POST, "/resources/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.DELETE, "/resources/**").hasRole("ADMIN")
                        // Datasource probe is fine for any user; creating one is admin-only.
                        .requestMatchers(HttpMethod.POST, "/datasources/*/test").authenticated()
                        .requestMatchers(HttpMethod.POST, "/datasources/**").hasRole("ADMIN")
                        // Everything else (all reads + remaining writes) requires a signed-in user.
                        .anyRequest().authenticated())
                .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }

    /**
     * CORS source mirroring the existing {@code WebConfig} so the Security filter chain
     * honours the same origins/credentials for the Next.js frontend.
     */
    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration cfg = new CorsConfiguration();
        // Use origin PATTERNS (not exact origins) so the app works behind any host/IP
        // (e.g. a NodePort test link). Patterns are valid with allowCredentials, and the API
        // authenticates via Bearer tokens (no cookies), so "*" carries no credential risk.
        // A same-origin POST still carries an Origin header, so an empty/"*" allowlist would
        // otherwise be rejected with 403 by the CORS filter.
        cfg.setAllowedOriginPatterns(
                (allowedOrigins.isEmpty() || allowedOrigins.contains("*"))
                        ? List.of("*")
                        : allowedOrigins);
        cfg.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        cfg.setAllowedHeaders(List.of("*"));
        cfg.setAllowCredentials(true);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cfg);
        return source;
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
