package io.reporthub.reportstudio.iam;

import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class PermissionPolicyTest {

    static RhPrincipal iam(Map<String, Set<String>> perms) {
        return new RhPrincipal("ann", "Ann", "iam", "acme", false, Set.of(), Set.of(), Map.of(), perms);
    }

    static boolean allowed(RhPrincipal p, String method, String path) {
        return EndpointPolicy.allows(EndpointPolicy.match(method, path), method, p);
    }

    @Test
    void iamGrantsDriveEndpointAccess() {
        RhPrincipal p = iam(Map.of("RH.REPORT", Set.of("view", "execute")));
        assertThat(allowed(p, "GET", "/reports")).isTrue();
        assertThat(allowed(p, "POST", "/reports/R1/run")).isTrue();
        assertThat(allowed(p, "PUT", "/reports/R1")).isFalse();
        assertThat(allowed(p, "DELETE", "/reports/R1")).isFalse();
        assertThat(allowed(p, "GET", "/jobs/J1")).isTrue();            // runner polls its job
        assertThat(allowed(p, "GET", "/datasets")).isFalse();
        assertThat(allowed(p, "GET", "/settings/iam")).isFalse();
    }

    @Test
    void parentGrantCoversChildObject() {
        RhPrincipal p = iam(Map.of("RH.REPORT", Set.of("update")));
        assertThat(PermissionService.can(p, "RH.REPORT.PARAMETER", "update")).isTrue();
        assertThat(PermissionService.can(p, "RH.REPORT.PARAMETER", "delete")).isFalse();
    }

    @Test
    void lookupsAndIdentityStayOpen() {
        RhPrincipal p = iam(Map.of());
        assertThat(allowed(p, "GET", "/datasources")).isTrue();
        assertThat(allowed(p, "GET", "/auth/me")).isTrue();
        assertThat(allowed(p, "GET", "/tenancy/mine")).isTrue();
        assertThat(allowed(p, "POST", "/datasources")).isFalse();
    }

    @Test
    void builtInUsersKeepTheirDefaults() {
        RhPrincipal user = new RhPrincipal("u", "u", "local", "default", false, Set.of("USER"), null, null, null);
        assertThat(allowed(user, "POST", "/datasets/5/aggregate")).isTrue();
        assertThat(allowed(user, "POST", "/reports/R1/run")).isTrue();
        assertThat(allowed(user, "GET", "/settings/iam")).isFalse();    // no admin areas
        assertThat(allowed(user, "PUT", "/settings/iam")).isFalse();
        assertThat(allowed(user, "GET", "/acl/REPORT/R1")).isFalse();
        assertThat(allowed(user, "DELETE", "/engines/E1")).isFalse();
        assertThat(allowed(user, "DELETE", "/reports/R1")).isFalse();
        var m = PermissionService.matrix(user);
        assertThat(m.get("RH")).containsExactly("view");
        assertThat(m).doesNotContainKeys("RH.SETTINGS", "RH.ACCESS", "RH.ENGINE", "RH.INTEGRATION");
        assertThat(allowed(user, "PUT", "/acl/REPORT/R1")).isFalse();
        RhPrincipal admin = new RhPrincipal("a", "a", "local", "default", true, null, null, null, null);
        assertThat(allowed(admin, "PUT", "/acl/REPORT/R1")).isTrue();
    }

    @Test
    void matrixListsOnlyGrantedActions() {
        var m = PermissionService.matrix(iam(Map.of("RH.DATASET", Set.of("view"))));
        assertThat(m).containsOnlyKeys("RH.DATASET");
        assertThat(m.get("RH.DATASET")).containsExactly("view");
    }

    @Test
    void everyCatalogObjectExportsWithIamFlags() {
        var doc = ObjectCatalog.exportDocument("RH");
        assertThat((java.util.List<?>) doc.get("objects")).hasSize(ObjectCatalog.OBJECTS.size());
        EndpointPolicy.rules().forEach(r -> r.anyOf().stream().filter(q -> !EndpointPolicy.ADMIN_ONLY.equals(q.code())).forEach(q ->
                assertThat(ObjectCatalog.find(q.code())).as(q.code()).isNotNull()));
    }
}
