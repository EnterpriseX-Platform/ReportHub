package io.reporthub.reportstudio.config;

import org.apache.catalina.core.StandardEngine;
import org.apache.catalina.valves.rewrite.RewriteValve;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class EdgeApiAliasConfigTest {

    private static final String ALIAS = "/reportstudio/edge-api";
    private static final String CTX = "/reportstudio/api";

    @Test
    void mapsAliasOntoTheContextPath() {
        assertThat(EdgeApiAliasConfig.buildRules(ALIAS, CTX))
                .contains("RewriteRule ^/reportstudio/edge-api$ /reportstudio/api/ [L]")
                .contains("RewriteRule ^/reportstudio/edge-api/(.*)$ /reportstudio/api/$1 [L]");
    }

    @Test
    void normalisesTrailingAndLeadingSlashes() {
        assertThat(EdgeApiAliasConfig.buildRules("reportstudio/edge-api/", "/reportstudio/api/"))
                .isEqualTo(EdgeApiAliasConfig.buildRules(ALIAS, CTX));
    }

    @Test
    void rejectsAnAliasEqualToTheContextPath() {
        // Aliasing the real path onto itself would defeat the point: /reportstudio/api must stay
        // un-fronted so the admin UI's own rs.token keeps working without an edge session.
        assertThatThrownBy(() -> EdgeApiAliasConfig.buildRules(CTX, CTX))
                .isInstanceOf(IllegalStateException.class);
    }

    /**
     * The real risk in this design: the rules are only useful if Tomcat's own mod_rewrite parser
     * accepts them. getConfiguration() re-renders the PARSED RewriteRule objects, so seeing the
     * alias come back proves they were understood rather than silently dropped.
     *
     * <p>The container is attached first because setConfiguration() derives a logger from it — which
     * is exactly why the valve defers its parse to startInternal(), when Tomcat has attached one.
     */
    @Test
    void tomcatParsesTheGeneratedRules() throws Exception {
        StandardEngine engine = new StandardEngine();
        engine.setName("Tomcat");
        RewriteValve valve = new RewriteValve();
        valve.setContainer(engine);

        valve.setConfiguration(EdgeApiAliasConfig.buildRules(ALIAS, CTX));

        String parsed = valve.getConfiguration();
        assertThat(parsed).contains("/reportstudio/edge-api");
        assertThat(parsed).contains("/reportstudio/api");
        assertThat(parsed.lines().filter(l -> l.startsWith("RewriteRule")).count()).isEqualTo(2);
    }
}
