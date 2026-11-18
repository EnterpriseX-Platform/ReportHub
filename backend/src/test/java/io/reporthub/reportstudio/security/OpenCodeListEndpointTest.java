package io.reporthub.reportstudio.security;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.junit.jupiter.SpringExtension;
import org.springframework.test.context.web.WebAppConfiguration;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;
import io.reporthub.reportstudio.service.ReportService;
import io.reporthub.reportstudio.web.ReportController;

import java.util.List;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * {@code GET /reports/codes} is the one read another service may call with no account, so what is
 * asserted here is the SIZE of that hole: the feed answers anonymously while its neighbours on the
 * same controller — the full registry list and the report writes — still demand a token.
 *
 * <p>Runs the real {@link SecurityConfig} chain over the real {@link ReportController} (service
 * mocked) rather than a stub, so a later rule reordering that widens the hole fails this test.
 */
@ExtendWith(SpringExtension.class)
@WebAppConfiguration
@ContextConfiguration(classes = OpenCodeListEndpointTest.TestConfig.class)
class OpenCodeListEndpointTest {

    @Autowired
    private WebApplicationContext wac;

    @Autowired
    private FilterChainProxy springSecurityFilterChain;

    private MockMvc mvc() {
        return MockMvcBuilders.webAppContextSetup(wac).addFilters(springSecurityFilterChain).build();
    }

    @Test
    void codeListAnswersWithoutAToken() throws Exception {
        mvc().perform(get("/reports/codes")).andExpect(status().isOk());
    }

    /** A caller holding a stale/garbage token must not be worse off than an anonymous one. */
    @Test
    void codeListAnswersWithAnUnparseableToken() throws Exception {
        mvc().perform(get("/reports/codes").header("Authorization", "Bearer not-a-jwt"))
                .andExpect(status().isOk());
    }

    @Test
    void theRegistryListStillNeedsAToken() throws Exception {
        mvc().perform(get("/reports")).andExpect(status().isUnauthorized());
    }

    @Test
    void reportDetailStillNeedsAToken() throws Exception {
        mvc().perform(get("/reports/SALES-102")).andExpect(status().isUnauthorized());
    }

    @Test
    void reportWritesStillNeedAToken() throws Exception {
        mvc().perform(post("/reports")).andExpect(status().isUnauthorized());
    }

    @Configuration
    @EnableWebMvc
    @EnableWebSecurity
    static class TestConfig {

        @Bean
        JwtService jwtService() {
            // HS512 needs a >= 64-byte key; the value itself is irrelevant here (no token is minted).
            return new JwtService("test-secret-test-secret-test-secret-test-secret-test-secret-1234", 120);
        }

        @Bean
        JwtAuthenticationFilter jwtAuthenticationFilter(JwtService jwtService) {
            return new JwtAuthenticationFilter(jwtService);
        }

        /** The production rules verbatim; no EdgeBearerAuthFilter bean exists, as in a dev profile. */
        @Bean
        SecurityFilterChain securityFilterChain(HttpSecurity http,
                                                JwtAuthenticationFilter jwtFilter,
                                                ObjectProvider<EdgeBearerAuthFilter> edgeProvider)
                throws Exception {
            return new SecurityConfig("*").securityFilterChain(http, jwtFilter, edgeProvider,
                    new io.reporthub.reportstudio.iam.AuthMode("local"), null,
                    mock(io.reporthub.reportstudio.tenancy.TenancyService.class));
        }

        @Bean
        ReportController reportController() {
            ReportService service = mock(ReportService.class);
            when(service.codeList(null)).thenReturn(List.of());
            return new ReportController(service);
        }
    }
}
