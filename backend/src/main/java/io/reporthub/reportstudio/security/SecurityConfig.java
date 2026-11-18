package io.reporthub.reportstudio.security;

import jakarta.servlet.DispatcherType;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import io.reporthub.reportstudio.iam.AuthMode;
import io.reporthub.reportstudio.iam.IamBearerAuthFilter;
import io.reporthub.reportstudio.iam.IamPrincipalService;
import io.reporthub.reportstudio.tenancy.TenancyService;
import io.reporthub.reportstudio.tenancy.TenantContextFilter;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Spring Security 6 filter chain for Report Studio.
 *
 * <p>Policy:
 * <ul>
 *   <li>Stateless (no session), CSRF disabled, CORS enabled for the Next.js frontend.</li>
 *   <li>Public: all {@code OPTIONS} preflights, {@code /auth/login}, {@code /public/**},
 *       {@code /actuator/**}, and {@code GET /reports/codes} (the code+name feed other
 *       services read without holding an account).</li>
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

    /**
     * EDGE AUTH: JWKS decoder for the OIDC access token injected by a gateway auth proxy
     * (e.g. oauth2-proxy). Created only when {@code edge.auth.jwk-set-uri} is set;
     * without it the app keeps its own-JWT-only behaviour unchanged.
     */
    @Bean
    @ConditionalOnProperty(name = "edge.auth.jwk-set-uri")
    public JwtDecoder edgeJwtDecoder(
            @Value("${edge.auth.jwk-set-uri}") String jwkSetUri,
            @Value("${edge.auth.issuer-uri:}") String issuerUri) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(jwkSetUri).build();
        OAuth2TokenValidator<Jwt> validator = (issuerUri == null || issuerUri.isBlank())
                ? JwtValidators.createDefault()                       // timestamp only
                : JwtValidators.createDefaultWithIssuer(issuerUri);   // + issuer match
        decoder.setJwtValidator(validator);
        return decoder;
    }

    @Bean
    @ConditionalOnProperty(name = "edge.auth.jwk-set-uri")
    public EdgeBearerAuthFilter edgeBearerAuthFilter(
            JwtDecoder edgeJwtDecoder,
            @Value("${edge.auth.accepted-azp:edge-gateway}") String acceptedAzp,
            @Value("${edge.auth.granted-role:USER}") String grantedRole,
            @Value("${edge.auth.roles-claim:roles}") String rolesClaim) {
        Set<String> azp = Arrays.stream(acceptedAzp.split(","))
                .map(String::trim).filter(s -> !s.isEmpty()).collect(Collectors.toSet());
        return new EdgeBearerAuthFilter(edgeJwtDecoder, azp, grantedRole.trim(), rolesClaim);
    }

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http,
                                                   JwtAuthenticationFilter jwtFilter,
                                                   ObjectProvider<EdgeBearerAuthFilter> edgeProvider,
                                                   AuthMode authMode,
                                                   IamPrincipalService iamPrincipals,
                                                   TenancyService tenancy) throws Exception {
        // Writes on platform objects: local mode = ADMIN role; IAM mode = any signed-in user here, and
        // the RH.<OBJECT>:<action> rule table (EndpointPolicy via PermissionInterceptor) decides.
        org.springframework.security.authorization.AuthorizationManager<
                org.springframework.security.web.access.intercept.RequestAuthorizationContext> adminWrite;
        if (authMode.isIam()) {
            adminWrite = org.springframework.security.authorization.AuthenticatedAuthorizationManager.authenticated();
        } else {
            adminWrite = org.springframework.security.authorization.AuthorityAuthorizationManager.hasRole("ADMIN");
        }
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
                        .requestMatchers("/auth/login", "/auth/logout").permitAll()
                        // Publicly shared dashboards (token URL) — no account needed to view.
                        .requestMatchers("/public/**").permitAll()
                        // The {code, name} feed only (GET, exact path): other services build a report
                        // picker from it without logging in. Deliberately the ONLY open read — every
                        // other GET, including the full registry list, still needs a token. NB an
                        // anonymous caller carries no portal roles, so this returns the whole registry
                        // (report codes + Thai names, no data) with no per-role visibility filter.
                        .requestMatchers(HttpMethod.GET, "/reports/codes").permitAll()
                        .requestMatchers("/actuator/**").permitAll()
                        .requestMatchers("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                        // Running a report is for any signed-in user (must precede the ADMIN write rules).
                        .requestMatchers(HttpMethod.POST, "/reports/*/run").authenticated()
                        // Uploading unit templates/subreports is for any signed-in user (config helpers
                        // are not ADMIN). Must precede the ADMIN write rule below.
                        .requestMatchers(HttpMethod.POST,
                                "/reports/*/units/*/files", "/reports/*/units/*/files/base64").authenticated()
                        // Admin surface: user management + writes on the platform objects.
                        .requestMatchers("/users/**").access(adminWrite)
                        .requestMatchers(HttpMethod.POST, "/reports/**").access(adminWrite)
                        .requestMatchers(HttpMethod.PUT, "/reports/**").access(adminWrite)
                        .requestMatchers(HttpMethod.DELETE, "/reports/**").access(adminWrite)
                        .requestMatchers(HttpMethod.POST, "/engines/**").access(adminWrite)
                        .requestMatchers(HttpMethod.PUT, "/engines/**").access(adminWrite)
                        .requestMatchers(HttpMethod.DELETE, "/engines/**").access(adminWrite)
                        .requestMatchers(HttpMethod.POST, "/parameters/**").access(adminWrite)
                        .requestMatchers(HttpMethod.PUT, "/parameters/**").access(adminWrite)
                        .requestMatchers(HttpMethod.DELETE, "/parameters/**").access(adminWrite)
                        // Shared resources (logos/images/fonts): readable by any user (the renderer
                        // and pickers need them); only ADMIN may upload/delete via the Settings page.
                        .requestMatchers(HttpMethod.POST, "/resources/**").access(adminWrite)
                        .requestMatchers(HttpMethod.DELETE, "/resources/**").access(adminWrite)
                        // Which tables a data screen offers: any signed-in user reads it (the screen
                        // needs the list to draw itself), only ADMIN changes what is on a screen.
                        .requestMatchers(HttpMethod.POST, "/repository/registry/**").access(adminWrite)
                        .requestMatchers(HttpMethod.PUT, "/repository/registry/**").access(adminWrite)
                        .requestMatchers(HttpMethod.DELETE, "/repository/registry/**").access(adminWrite)
                        // Sidebar folders - same rule as the registry: everyone reads, only ADMIN writes
                        .requestMatchers(HttpMethod.POST, "/repository/folders/**").access(adminWrite)
                        .requestMatchers(HttpMethod.PUT, "/repository/folders/**").access(adminWrite)
                        .requestMatchers(HttpMethod.DELETE, "/repository/folders/**").access(adminWrite)
                        // Datasource probe is fine for any user; creating / setting-default / deleting
                        // is admin-only (the POST /datasources/** rule also covers /{id}/default).
                        .requestMatchers(HttpMethod.POST, "/categories/**").access(adminWrite)
                        .requestMatchers(HttpMethod.PUT, "/categories/**").access(adminWrite)
                        .requestMatchers(HttpMethod.DELETE, "/categories/**").access(adminWrite)
                        .requestMatchers(HttpMethod.POST, "/datasources/*/test").authenticated()
                        .requestMatchers(HttpMethod.POST, "/datasources/**").access(adminWrite)
                        .requestMatchers(HttpMethod.DELETE, "/datasources/**").access(adminWrite)
                        // Everything else (all reads + remaining writes) requires a signed-in user.
                        .anyRequest().authenticated())
                .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);

        // EDGE AUTH: fallback for pages in other host apps (rs-export.js) calling
        // through the gateway. Added AFTER the app filter so Report Studio's own rs.token always
        // wins; the two are disjoint anyway — an app token fails JWKS verify, and a Keycloak token
        // fails the app's HS512 parse (which leaves the context empty rather than rejecting).
        // Absent when edge.auth.jwk-set-uri is unset → behaviour unchanged.
        EdgeBearerAuthFilter edge = edgeProvider.getIfAvailable();
        if (edge != null) {
            http.addFilterAfter(edge, JwtAuthenticationFilter.class);
        }

        // IAM mode: an IAM-issued bearer token (not the app's own JWT) is validated against the
        // IAM service and turned into a principal with IAM roles, responsibilities and permissions.
        if (authMode.isIam()) {
            http.addFilterAfter(new IamBearerAuthFilter(iamPrincipals), JwtAuthenticationFilter.class);
        }
        // Tenant + project of the request, after every authentication filter has run.
        http.addFilterBefore(new TenantContextFilter(tenancy), AuthorizationFilter.class);

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
        cfg.setExposedHeaders(List.of("X-Project-Fallback"));
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
