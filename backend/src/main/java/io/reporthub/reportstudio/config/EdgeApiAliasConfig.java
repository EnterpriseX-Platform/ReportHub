package io.reporthub.reportstudio.config;

import org.apache.catalina.LifecycleException;
import org.apache.catalina.valves.rewrite.RewriteValve;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * EDGE API ALIAS — expose the API under a SECOND path that a gateway auth proxy
 * (e.g. oauth2-proxy) can front, without touching the real one.
 *
 * <p><b>Why this exists.</b> The proxy injects {@code X-Forwarded-Access-Token} only for paths it
 * proxies, and oauth2-proxy's {@code --upstream} does <em>not</em> rewrite paths — it forwards the
 * request path verbatim. Fronting the real {@code /reportstudio/api} would therefore force every
 * caller of it through an edge session and 302 the Report Studio admin UI (which authenticates with
 * its own {@code rs.token}) to Keycloak. So the proxy gets its own alias path instead:
 *
 * <pre>
 *   browser → /reportstudio/edge-api/reports
 *           → oauth2-proxy (adds X-Forwarded-Access-Token) → reportstudio-api:8080
 *           → this valve rewrites to /reportstudio/api/reports → normal handlers
 * </pre>
 *
 * The real {@code /reportstudio/api} keeps working exactly as before, untouched.
 *
 * <p><b>Why a valve and not a servlet Filter.</b> Tomcat selects the Context from the request URI in
 * {@code CoyoteAdapter.postParseRequest()}, i.e. <em>before</em> any filter runs. A URI outside
 * {@code server.servlet.context-path} never reaches this app's context at all — it 404s at the
 * container. Only a valve ahead of context matching can help, and {@link RewriteValve} is the
 * built-in one: when it is not installed inside a Context it re-runs the Mapper after rewriting, so
 * the rewritten URI lands on the right context. Hence {@code addEngineValves}, not a Filter.
 *
 * <p><b>Fail-safe.</b> Off unless {@code edge.auth.edge-api-alias} is set, and even then it only
 * rewrites URIs under that one prefix — every other path is untouched, so a mistake here cannot
 * break the existing API. Pairs with {@code EdgeBearerAuthFilter}, which verifies the token the
 * proxy injects.
 */
@Configuration
public class EdgeApiAliasConfig {

    @Bean
    @ConditionalOnProperty(name = "edge.auth.edge-api-alias")
    public WebServerFactoryCustomizer<TomcatServletWebServerFactory> edgeApiAliasCustomizer(
            @Value("${edge.auth.edge-api-alias}") String alias,
            @Value("${server.servlet.context-path:/api}") String contextPath) {

        String rules = buildRules(alias, contextPath);
        // Engine level = ahead of context matching (a Context/Host valve would be too late).
        return factory -> factory.addEngineValves(new ConfiguredRewriteValve(rules));
    }

    /**
     * A {@link RewriteValve} whose rules come from configuration rather than a {@code rewrite.config}
     * file on disk.
     *
     * <p>The parse has to happen in {@code startInternal()}, not at construction:
     * {@code setConfiguration()} derives a logger from {@code getContainer()}, and the container is
     * only attached when Tomcat builds the engine — calling it earlier NPEs at boot. By then
     * {@code super.startInternal()} has already looked for a {@code rewrite.config} and found none
     * (embedded Tomcat has no conf/ dir), which leaves the rule list empty for us to fill.
     */
    static final class ConfiguredRewriteValve extends RewriteValve {

        private final String rules;

        ConfiguredRewriteValve(String rules) {
            this.rules = rules;
        }

        @Override
        protected synchronized void startInternal() throws LifecycleException {
            super.startInternal();
            try {
                setConfiguration(rules);
            } catch (Exception e) {
                throw new LifecycleException("Invalid edge-api alias rewrite rules: " + rules, e);
            }
        }
    }

    /**
     * mod_rewrite rules mapping the alias prefix onto the context path. Two rules so the bare prefix
     * (no trailing segment) lands on the context root instead of 404ing.
     */
    static String buildRules(String alias, String contextPath) {
        String from = normalize(alias);
        String to = normalize(contextPath);
        if (from.isEmpty() || from.equals(to)) {
            throw new IllegalStateException(
                    "edge.auth.edge-api-alias must be a non-empty path different from the context-path ("
                            + to + "); got: " + alias);
        }
        return "RewriteRule ^" + from + "$ " + to + "/ [L]\n"
             + "RewriteRule ^" + from + "/(.*)$ " + to + "/$1 [L]\n";
    }

    /** "/x/" → "/x" · "x" → "/x" · "/" or blank → "". */
    private static String normalize(String path) {
        if (path == null) return "";
        String p = path.trim();
        while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
        if (p.isEmpty()) return "";
        return p.startsWith("/") ? p : "/" + p;
    }
}
