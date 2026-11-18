package io.reporthub.reportstudio.round2;

import io.reporthub.reportstudio.iam.CurrentPrincipal;
import io.reporthub.reportstudio.iam.EndpointPolicy;
import io.reporthub.reportstudio.iam.RhPrincipal;
import io.reporthub.reportstudio.repo.RepoTableRepository;
import io.reporthub.reportstudio.security.JwtService;
import io.reporthub.reportstudio.security.LoginLockout;
import io.reporthub.reportstudio.service.AppDatabaseGuard;
import io.jsonwebtoken.JwtException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import java.lang.reflect.Method;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Security regression tests. */
class E2eRound2SecurityTest {

    static RhPrincipal iam(String user, boolean admin, Map<String, Set<String>> perms) {
        return new RhPrincipal(user, user, "iam", "t1", admin, Set.of(), Set.of(), Map.of(), perms);
    }

    static RhPrincipal local(String user, boolean admin) {
        return new RhPrincipal(user, user, "local", "default", admin, Set.of(), Set.of(), Map.of(), null);
    }

    @AfterEach
    void reset() { AppDatabaseGuard.setAppUrl(null); }

    // ---- 1. /users is ReportHub-admin only, never an RH.SETTINGS grant
    @Test
    void usersEndpointIgnoresSettingsGrant() {
        var rule = EndpointPolicy.match("POST", "/users");
        var settingsHolder = iam("u", false, Map.of("RH.SETTINGS", Set.of("view", "update"), "RH", Set.of("view", "create", "update", "delete")));
        assertThat(EndpointPolicy.allows(rule, "POST", settingsHolder)).isFalse();
        assertThat(EndpointPolicy.allows(EndpointPolicy.match("GET", "/users"), "GET", settingsHolder)).isFalse();
        assertThat(EndpointPolicy.allows(EndpointPolicy.match("POST", "/users/bob/password"), "POST", settingsHolder)).isFalse();
        assertThat(EndpointPolicy.allows(rule, "POST", iam("a", true, Map.of()))).isTrue();
        assertThat(EndpointPolicy.allows(rule, "POST", local("admin", true))).isTrue();
        assertThat(EndpointPolicy.allows(rule, "POST", local("user", false))).isFalse();
    }

    @Test
    void iamAdminRolesAndUsersFromConfig() {
        var s = new io.reporthub.reportstudio.iam.IamSettings(null, "", 60, 5000);
        s.setAdminRolesAndUsers("RH_ADMIN, platform-admin", "c-iamadmin");
        assertThat(s.isConfiguredAdmin("someone", Set.of("rh_admin"))).isTrue();
        assertThat(s.isConfiguredAdmin("C-IAMADMIN", Set.of())).isTrue();
        assertThat(s.isConfiguredAdmin("c-iambuilder", Set.of("BUILDER"))).isFalse();
        var none = new io.reporthub.reportstudio.iam.IamSettings(null, "", 60, 5000);
        assertThat(none.isConfiguredAdmin("x", Set.of("ADMIN"))).isFalse();
    }

    @Test
    void iamAdminCannotCreateLocalAdminOrResetPasswords() throws Throwable {
        Class<?> uc = Class.forName("io.reporthub.reportstudio.security.UserController");
        Method req = uc.getDeclaredMethod("requireLocalAdmin", RhPrincipal.class, String.class);
        req.setAccessible(true);
        assertThatThrownBy(() -> invoke(req, iam("a", true, Map.of()), "x")).isInstanceOf(ResponseStatusException.class);
        assertThatCode(() -> invoke(req, local("admin", true), "x")).doesNotThrowAnyException();
        Method caller = uc.getDeclaredMethod("caller");
        caller.setAccessible(true);
        CurrentPrincipal.runAs(iam("u", false, Map.of("RH.SETTINGS", Set.of("update"))),
                () -> assertThatThrownBy(() -> invoke(caller)).isInstanceOf(ResponseStatusException.class));
        Method tenant = uc.getDeclaredMethod("tenantOf", RhPrincipal.class);
        tenant.setAccessible(true);
        assertThat(invoke(tenant, iam("a", true, Map.of()))).isEqualTo("t1");
    }

    static Object invoke2(Object target, Method m, Object... args) throws Throwable {
        try { return m.invoke(target, args); } catch (java.lang.reflect.InvocationTargetException e) { throw e.getCause(); }
    }

    static Object invoke(Method m, Object... args) throws Throwable {
        try { return m.invoke(null, args); } catch (java.lang.reflect.InvocationTargetException e) { throw e.getCause(); }
    }

    // ---- 2. optionsFrom specs come only from the registry entry's filter columns
    @Test
    void optionsFromSpecsParsedFromFilterColumns() throws Throwable {
        Class<?> rc = Class.forName("io.reporthub.reportstudio.web.RepositoryController");
        Method m = rc.getDeclaredMethod("configuredOptionsFrom", String.class);
        m.setAccessible(true);
        assertThat((java.util.List<Object>) invoke(m, "REGION:Region::core.V_REGION.CODE.NAME,BRANCH:Branch::core.V_BRANCH.CODE.NAME@REGION_CODE=REGION,YEAR:Year"))
                .containsExactly("core.V_REGION.CODE.NAME", "core.V_BRANCH.CODE.NAME@REGION_CODE=REGION");
        assertThat((java.util.List<Object>) invoke(m, (Object) null)).isEqualTo(java.util.List.of());
    }

    // ---- 3. the app's own database and internal schemas
    @Test
    void appDatabaseDetected() {
        AppDatabaseGuard.setAppUrl("jdbc:postgresql://localhost:5441/reportstudio");
        assertThat(AppDatabaseGuard.isAppDatabase("jdbc:postgresql://127.0.0.1:5441/reportstudio?ssl=false")).isTrue();
        assertThat(AppDatabaseGuard.isAppDatabase("jdbc:postgresql://LOCALHOST:5441/ReportStudio")).isTrue();
        assertThat(AppDatabaseGuard.isAppDatabase("jdbc:postgresql://localhost:5441/warehouse")).isFalse();
        assertThat(AppDatabaseGuard.isAppDatabase("jdbc:postgresql://db.example:5441/reportstudio")).isFalse();
        assertThat(AppDatabaseGuard.isAppDatabase("jdbc:oracle:thin:@//h:1521/X")).isFalse();
        AppDatabaseGuard.setAppUrl("jdbc:postgresql://pg/reportstudio");
        assertThat(AppDatabaseGuard.isAppDatabase("jdbc:postgresql://pg:5432/reportstudio")).isTrue();
    }

    @Test
    void nonAdminBlockedFromAppDatabaseAndInternalSchemas() {
        AppDatabaseGuard.setAppUrl("jdbc:postgresql://localhost:5441/reportstudio");
        CurrentPrincipal.runAs(local("user", false), () -> {
            assertThatThrownBy(() -> AppDatabaseGuard.checkDatasourceUrl("jdbc:postgresql://127.0.0.1:5441/reportstudio"))
                    .isInstanceOf(ResponseStatusException.class);
            assertThatCode(() -> AppDatabaseGuard.checkDatasourceUrl("jdbc:postgresql://localhost:5441/other")).doesNotThrowAnyException();
            assertThatThrownBy(() -> AppDatabaseGuard.checkSchema("pg_catalog")).isInstanceOf(ResponseStatusException.class);
            assertThatThrownBy(() -> AppDatabaseGuard.checkSchema("INFORMATION_SCHEMA")).isInstanceOf(ResponseStatusException.class);
            assertThatThrownBy(() -> AppDatabaseGuard.checkSql("select * from pg_catalog.pg_authid")).isInstanceOf(ResponseStatusException.class);
            assertThatThrownBy(() -> AppDatabaseGuard.checkSql("SELECT usename, passwd FROM pg_shadow")).isInstanceOf(ResponseStatusException.class);
            assertThatCode(() -> AppDatabaseGuard.checkSql("select my_pg_stat from sales")).doesNotThrowAnyException();
        });
        CurrentPrincipal.runAs(local("admin", true), () -> {
            assertThatCode(() -> AppDatabaseGuard.checkDatasourceUrl("jdbc:postgresql://127.0.0.1:5441/reportstudio")).doesNotThrowAnyException();
            assertThatCode(() -> AppDatabaseGuard.checkSchema("pg_catalog")).doesNotThrowAnyException();
        });
    }

    // ---- 5. findForPhysicalTable never binds an untyped null
    @Test
    void physicalTableLookupSplitsOnSchema() {
        RepoTableRepository repo = org.mockito.Mockito.mock(RepoTableRepository.class,
                org.mockito.Mockito.withSettings().defaultAnswer(org.mockito.Mockito.CALLS_REAL_METHODS));
        org.mockito.Mockito.doReturn(java.util.List.of()).when(repo).findForTableAnySchema("T");
        org.mockito.Mockito.doReturn(java.util.List.of()).when(repo).findForTableInSchema("S", "T");
        repo.findForPhysicalTable(null, "T");
        repo.findForPhysicalTable(" ", "T");
        repo.findForPhysicalTable("S", "T");
        org.mockito.Mockito.verify(repo, org.mockito.Mockito.times(2)).findForTableAnySchema("T");
        org.mockito.Mockito.verify(repo).findForTableInSchema("S", "T");
    }

    // ---- 7. plugin JARs must declare a ReportEngine service
    @Test
    void pluginJarMustDeclareEngine() throws Exception {
        assertThat(io.reporthub.reportstudio.engine.PluginEngineLoader.declaresEngine(jar("META-INF/services/io.reporthub.reportstudio.engine.ReportEngine", "# c\ncom.acme.MyEngine\n"))).isTrue();
        assertThat(io.reporthub.reportstudio.engine.PluginEngineLoader.declaresEngine(jar("META-INF/services/io.reporthub.reportstudio.engine.ReportEngine", "# only a comment\n"))).isFalse();
        assertThat(io.reporthub.reportstudio.engine.PluginEngineLoader.declaresEngine(jar("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\n"))).isFalse();
        assertThat(io.reporthub.reportstudio.engine.PluginEngineLoader.declaresEngine("not a zip".getBytes())).isFalse();
    }

    @Test
    void pluginInstallNeedsReportHubAdmin() throws Exception {
        Class<?> ec = Class.forName("io.reporthub.reportstudio.web.EngineController");
        Method m = ec.getDeclaredMethod("requirePluginAdmin");
        m.setAccessible(true);
        CurrentPrincipal.runAs(iam("b", false, Map.of("RH.ENGINE", Set.of("view", "create", "update", "delete", "execute"))),
                () -> assertThatThrownBy(() -> invoke(m)).isInstanceOf(ResponseStatusException.class));
        CurrentPrincipal.runAs(local("user", false), () -> assertThatThrownBy(() -> invoke(m)).isInstanceOf(ResponseStatusException.class));
        CurrentPrincipal.runAs(local("admin", true), () -> assertThatCode(() -> invoke(m)).doesNotThrowAnyException());
        CurrentPrincipal.runAs(iam("a", true, Map.of()), () -> assertThatCode(() -> invoke(m)).doesNotThrowAnyException());
    }

    static byte[] jar(String entry, String content) throws Exception {
        var bo = new java.io.ByteArrayOutputStream();
        try (var z = new java.util.zip.ZipOutputStream(bo)) {
            z.putNextEntry(new java.util.zip.ZipEntry(entry));
            z.write(content.getBytes());
            z.closeEntry();
        }
        return bo.toByteArray();
    }

    // ---- 4 + 21. sign-out denylist for IAM tokens; millisecond revocation
    @Test
    void iamTokenRevokedLocally() {
        JwtService jwt = new JwtService("0123456789abcdef0123456789abcdef0123456789", 60);
        String foreign = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4IiwiZXhwIjo0MTAyNDQ0ODAwfQ.sig";
        assertThat(jwt.isForeignRevoked(foreign)).isFalse();
        jwt.revokeForeign(foreign);
        assertThat(jwt.isForeignRevoked(foreign)).isTrue();
        assertThat(jwt.isForeignRevoked(foreign + "x")).isFalse();
    }

    @Test
    void tokenFromBeforeResetRejectedEvenInSameSecond() {
        JwtService jwt = new JwtService("0123456789abcdef0123456789abcdef0123456789", 60);
        String before = jwt.generate("bob", "USER");
        jwt.revokeAllFor("bob");
        String after = jwt.generate("bob", "USER");
        assertThatThrownBy(() -> jwt.parse(before)).isInstanceOf(JwtException.class);
        assertThat(jwt.parse(after).getSubject()).isEqualTo("bob");
    }

    @Test
    void adminResetLiftsLockout() {
        LoginLockout l = new LoginLockout();
        for (int i = 0; i < LoginLockout.MAX_FAILURES; i++) l.failed("bob|1.2.3.4");
        l.failed("bobby|1.2.3.4");
        assertThat(l.isLocked("bob|1.2.3.4")).isTrue();
        l.clear("Bob");
        assertThat(l.isLocked("bob|1.2.3.4")).isFalse();
        for (int i = 0; i < LoginLockout.MAX_FAILURES; i++) l.failed("bobby|1.2.3.4");
        l.clear("bob");
        assertThat(l.isLocked("bobby|1.2.3.4")).isTrue();
    }
}
