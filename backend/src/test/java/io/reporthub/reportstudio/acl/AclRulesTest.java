package io.reporthub.reportstudio.acl;

import io.reporthub.reportstudio.iam.RhPrincipal;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AclRulesTest {

    static RhPrincipal user(String name, Set<String> roles, Set<String> resps) {
        return new RhPrincipal(name, name, "iam", "t", false, roles, resps, Map.of(), Map.of());
    }

    static final RhPrincipal ANALYST = user("ann", Set.of("ANALYST"), Set.of("FIN-REPORTS"));
    static final RhPrincipal ADMIN = new RhPrincipal("root", "root", "iam", "t", true, null, null, null, Map.of());

    @Test
    void objectWithoutGrantsIsOpen() {
        assertThat(AclRules.allowed(List.of(), ANALYST, "edit")).isTrue();
        assertThat(AclRules.allowed(null, ANALYST, "view")).isTrue();
    }

    @Test
    void roleGrantAllowsUpToItsLevel() {
        var grants = List.of(new AclRules.Grant("role", "ANALYST", "run"));
        assertThat(AclRules.allowed(grants, ANALYST, "view")).isTrue();
        assertThat(AclRules.allowed(grants, ANALYST, "run")).isTrue();
        assertThat(AclRules.allowed(grants, ANALYST, "edit")).isFalse();
    }

    @Test
    void responsibilityAndUserGrantsMatch() {
        assertThat(AclRules.allowed(List.of(new AclRules.Grant("responsibility", "FIN-REPORTS", "view")), ANALYST, "view")).isTrue();
        assertThat(AclRules.allowed(List.of(new AclRules.Grant("user", "ann", "edit")), ANALYST, "edit")).isTrue();
        assertThat(AclRules.allowed(List.of(new AclRules.Grant("user", "bob", "edit")), ANALYST, "view")).isFalse();
    }

    @Test
    void codesMustMatchExactly() {
        var grants = List.of(new AclRules.Grant("role", "ANALYST-II", "edit"));
        assertThat(AclRules.allowed(grants, ANALYST, "view")).isFalse();
    }

    @Test
    void grantedObjectsAreClosedToOthers() {
        var grants = List.of(new AclRules.Grant("role", "MANAGER", "view"));
        assertThat(AclRules.allowed(grants, ANALYST, "view")).isFalse();
        assertThat(AclRules.allowed(grants, null, "view")).isFalse();
    }

    @Test
    void adminBypasses() {
        assertThat(AclRules.allowed(List.of(new AclRules.Grant("role", "MANAGER", "view")), ADMIN, "edit")).isTrue();
    }

    @Test
    void unknownPermissionIsRejected() {
        assertThatThrownBy(() -> AclRules.rank("owner")).isInstanceOf(IllegalArgumentException.class);
        assertThat(AclRules.atLeast("run")).containsExactly("run", "edit");
    }
}
