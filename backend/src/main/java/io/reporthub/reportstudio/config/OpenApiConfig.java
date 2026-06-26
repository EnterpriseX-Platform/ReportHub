package io.reporthub.reportstudio.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * OpenAPI document for Report Studio. The full spec is auto-generated from the controllers and
 * served at {@code /api/v3/api-docs}; Swagger UI at {@code /api/swagger-ui/index.html}.
 * A Bearer-JWT scheme is declared so the "Authorize" button can carry the token from /auth/login.
 */
@Configuration
public class OpenApiConfig {

    @Bean
    public OpenAPI reportStudioOpenApi() {
        return new OpenAPI()
                .info(new Info()
                        .title("Report Studio API")
                        .version("0.1.0")
                        .description("""
                                Report platform — report registry, Kafka render gateway,
                                pluggable engines, output store, ad-hoc/analytics, and JWT auth/RBAC.
                                GET endpoints are public; writes need a Bearer token (POST/PUT/DELETE under
                                /reports require the ADMIN role). Get a token from POST /auth/login."""))
                .components(new Components().addSecuritySchemes("bearerAuth",
                        new SecurityScheme()
                                .type(SecurityScheme.Type.HTTP)
                                .scheme("bearer")
                                .bearerFormat("JWT")
                                .description("Paste the token from POST /auth/login")));
    }
}
