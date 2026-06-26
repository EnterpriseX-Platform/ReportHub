package io.reporthub.reportstudio.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final String[] allowedOriginPatterns;

    public WebConfig(@Value("${app.cors.allowed-origins}") String origins) {
        String[] parts = java.util.Arrays.stream(origins.split(","))
                .map(String::trim).filter(s -> !s.isEmpty()).toArray(String[]::new);
        // Mirror SecurityConfig: use origin patterns (work behind any host/IP, e.g. a NodePort
        // test link) and fall back to "*" when unset. Bearer-token auth → no cookie risk.
        this.allowedOriginPatterns =
                (parts.length == 0 || java.util.Arrays.asList(parts).contains("*"))
                        ? new String[]{"*"} : parts;
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns(allowedOriginPatterns)
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(true);
    }
}
