package io.reporthub.reportstudio.engine.remote;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Supplies a Keycloak access token for a configured SERVICE account, so an api-engine report that opts
 * in ({@code forwardEdgeToken}) can still reach a gateway-fronted endpoint (e.g. {@code /api/export})
 * when it is run WITHOUT an edge session — i.e. from the Report Studio admin Run Task screen, where the
 * caller authenticated with the app's own {@code rs.token} and no Keycloak token exists to forward.
 *
 * <p>The token is obtained via the OAuth2 password grant against Keycloak and cached in memory until
 * shortly before it expires, so a burst of renders shares one grant. Everything is env-driven and the
 * password is never logged:
 * <pre>
 *   app.engine.api.service-token.token-url    Keycloak token endpoint — MUST be the PUBLIC url so the
 *                                             minted token's `iss` matches what the oauth2-proxy expects
 *                                             (e.g. https://host/idp/realms/app/protocol/openid-connect/token)
 *   app.engine.api.service-token.client-id     a client with Direct Access Grants; its tokens must carry
 *                                             an `aud` the proxy accepts (add an Audience mapper if needed)
 *   app.engine.api.service-token.client-secret (blank for a public client)
 *   app.engine.api.service-token.username      the service user
 *   app.engine.api.service-token.password      the service user's password (inject from a k8s Secret)
 * </pre>
 *
 * <p>Disabled (returns {@code null}) unless url + client-id + username + password are all set, so the
 * fallback is opt-in per environment and MDP-style reports simply stay unavailable from the admin Run
 * screen until it is configured — a real edge run (rs-export button) never needs this.
 */
@Component
public class EdgeServiceTokenProvider {

    private static final Logger log = LoggerFactory.getLogger(EdgeServiceTokenProvider.class);
    /** Refresh this many seconds BEFORE the token's own expiry, so a render never uses an about-to-die token. */
    private static final long EXPIRY_SKEW_SECONDS = 30;

    private final ObjectMapper mapper;
    private final HttpClient http;
    private final String tokenUrl;
    private final String clientId;
    private final String clientSecret;
    private final String username;
    private final String password;
    private final boolean configured;

    private final Object lock = new Object();
    private volatile String cachedToken;
    private volatile long expiresAtMs;

    public EdgeServiceTokenProvider(
            ObjectMapper objectMapper,
            @Value("${app.engine.api.service-token.token-url:}") String tokenUrl,
            @Value("${app.engine.api.service-token.client-id:}") String clientId,
            @Value("${app.engine.api.service-token.client-secret:}") String clientSecret,
            @Value("${app.engine.api.service-token.username:}") String username,
            @Value("${app.engine.api.service-token.password:}") String password,
            @Value("${app.engine.remote.insecure-tls:false}") boolean insecureTls) {
        this.mapper = objectMapper;
        this.http = InsecureTls.client(insecureTls, Duration.ofSeconds(10));
        this.tokenUrl = trim(tokenUrl);
        this.clientId = trim(clientId);
        this.clientSecret = trim(clientSecret);
        this.username = trim(username);
        this.password = password == null ? "" : password;
        this.configured = !this.tokenUrl.isEmpty() && !this.clientId.isEmpty()
                && !this.username.isEmpty() && !this.password.isEmpty();
        if (configured) {
            log.info("Edge service-token fallback ENABLED (client={} user={} url={})", clientId, username, tokenUrl);
        }
    }

    /** Whether a service account is configured for this environment. */
    public boolean isConfigured() {
        return configured;
    }

    /**
     * A currently-valid service access token, or {@code null} when not configured or the grant fails
     * (the caller then simply forwards nothing). Cached until {@link #EXPIRY_SKEW_SECONDS} before expiry.
     */
    public String getToken() {
        if (!configured) return null;
        String t = cachedToken;
        if (t != null && System.currentTimeMillis() < expiresAtMs) return t;
        synchronized (lock) {
            if (cachedToken != null && System.currentTimeMillis() < expiresAtMs) return cachedToken;
            String fresh = requestToken();
            // keep the (now-expired) cache cleared on failure so a later call retries rather than serving stale
            if (fresh == null) { cachedToken = null; expiresAtMs = 0; }
            return fresh;
        }
    }

    private String requestToken() {
        try {
            StringBuilder form = new StringBuilder()
                    .append("grant_type=password")
                    .append("&client_id=").append(enc(clientId))
                    .append("&username=").append(enc(username))
                    .append("&password=").append(enc(password))
                    .append("&scope=openid");
            if (!clientSecret.isEmpty()) form.append("&client_secret=").append(enc(clientSecret));

            HttpRequest req = HttpRequest.newBuilder(URI.create(tokenUrl))
                    .timeout(Duration.ofSeconds(15))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .header("Accept", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(form.toString()))
                    .build();
            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() / 100 != 2) {
                // Log the OAuth error code only (e.g. invalid_grant), never the response body / credentials.
                log.warn("service-token grant failed: HTTP {} ({})", resp.statusCode(), oauthError(resp.body()));
                return null;
            }
            JsonNode json = mapper.readTree(resp.body());
            String at = json.path("access_token").asText(null);
            if (at == null || at.isBlank()) {
                log.warn("service-token grant returned no access_token");
                return null;
            }
            long expiresIn = json.path("expires_in").asLong(60);
            cachedToken = at;
            expiresAtMs = System.currentTimeMillis() + Math.max(10, expiresIn - EXPIRY_SKEW_SECONDS) * 1000L;
            log.debug("service-token grant ok (expires_in={}s)", expiresIn);
            return at;
        } catch (Exception e) {
            log.warn("service-token grant error: {}", e.toString());
            return null;
        }
    }

    /** Pull just the {@code error} field out of a Keycloak error body — never echo the whole payload. */
    private String oauthError(String body) {
        if (body == null) return "";
        try {
            return mapper.readTree(body).path("error").asText("");
        } catch (Exception e) {
            return "";
        }
    }

    private static String enc(String v) {
        return URLEncoder.encode(v, StandardCharsets.UTF_8);
    }

    private static String trim(String s) {
        return s == null ? "" : s.trim();
    }
}
