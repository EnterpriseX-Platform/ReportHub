package io.reporthub.reportstudio.security;

import io.reporthub.reportstudio.acl.AccessController;
import io.reporthub.reportstudio.web.BadRequestException;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AccessValidationTest {
    @Test
    void numberRuleValuesMustBeNumbers() {
        AccessController.validateNumberValues("100, 200");
        AccessController.validateNumberValues("${user.departmentCode}");
        assertThatThrownBy(() -> AccessController.validateNumberValues("100 OR 1=1")).isInstanceOf(BadRequestException.class);
    }
}
