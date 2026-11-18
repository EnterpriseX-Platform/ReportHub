package io.reporthub.reportstudio.acl;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AclInterceptorTest {

    @Test
    void mapsIdAddressedEndpointsToPermissions() {
        assertThat(AclInterceptor.requirement("GET", "/datasets/5/fields")).containsExactly("DATASET", "5", "view");
        assertThat(AclInterceptor.requirement("POST", "/datasets/5/aggregate")).containsExactly("DATASET", "5", "run");
        assertThat(AclInterceptor.requirement("PUT", "/datasets/5")).containsExactly("DATASET", "5", "edit");
        assertThat(AclInterceptor.requirement("GET", "/documents/9")).containsExactly("DOCUMENT", "9", "view");
        assertThat(AclInterceptor.requirement("POST", "/documents/9/pdf")).containsExactly("DOCUMENT", "9", "run");
        assertThat(AclInterceptor.requirement("POST", "/documents/9/data")).containsExactly("DOCUMENT", "9", "run");
        assertThat(AclInterceptor.requirement("PUT", "/documents/9")).containsExactly("DOCUMENT", "9", "edit");
        assertThat(AclInterceptor.requirement("POST", "/documents/data")).isNull();
        assertThat(AclInterceptor.requirement("POST", "/reports/R1/run")).containsExactly("REPORT", "R1", "run");
        assertThat(AclInterceptor.requirement("GET", "/dashboards/3/data")).containsExactly("DASHBOARD", "3", "run");
        assertThat(AclInterceptor.requirement("DELETE", "/repository/registry/9")).containsExactly("REPO_TABLE", "9", "edit");
    }

    @Test
    void collectionEndpointsAreNotObjectChecks() {
        assertThat(AclInterceptor.requirement("GET", "/reports/codes")).isNull();
        assertThat(AclInterceptor.requirement("POST", "/datasets/preview")).isNull();
        assertThat(AclInterceptor.requirement("GET", "/datasets")).isNull();
    }
}
