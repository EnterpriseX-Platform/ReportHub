package io.reporthub.reportstudio.integration;

import io.reporthub.reportstudio.security.EncryptionService;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ConnectorConfigTest {

    private final EncryptionService enc = new EncryptionService("unit-test-key");

    @Test
    void newSecretIsEncryptedAndMasked() {
        Map<String, Object> stored = ConnectorConfig.merge("filehub", Map.of(),
                Map.of("baseUrl", "http://fh/fh", "apiKey", "fhk_secret"), enc);
        assertThat(String.valueOf(stored.get("apiKey"))).startsWith("enc:v1:").doesNotContain("fhk_secret");
        assertThat(ConnectorConfig.secret(stored, "apiKey", enc)).isEqualTo("fhk_secret");
        Map<String, Object> shown = ConnectorConfig.mask("filehub", stored);
        assertThat(shown.get("apiKey")).isEqualTo(ConnectorConfig.MASK);
        assertThat(shown.get("baseUrl")).isEqualTo("http://fh/fh");
    }

    @Test
    void maskOrBlankKeepsStoredSecret() {
        Map<String, Object> stored = ConnectorConfig.merge("filehub", Map.of(), Map.of("apiKey", "fhk_one"), enc);
        Map<String, Object> m1 = ConnectorConfig.merge("filehub", stored, Map.of("apiKey", ConnectorConfig.MASK), enc);
        Map<String, Object> blank = new HashMap<>();
        blank.put("apiKey", "");
        Map<String, Object> m2 = ConnectorConfig.merge("filehub", stored, blank, enc);
        Map<String, Object> m3 = ConnectorConfig.merge("filehub", stored, Map.of("systemId", "sys_x"), enc);
        for (Map<String, Object> m : new Map[]{m1, m2, m3})
            assertThat(ConnectorConfig.secret(m, "apiKey", enc)).isEqualTo("fhk_one");
        Map<String, Object> m4 = ConnectorConfig.merge("filehub", stored, Map.of("apiKey", "fhk_two"), enc);
        assertThat(ConnectorConfig.secret(m4, "apiKey", enc)).isEqualTo("fhk_two");
    }

    @Test
    void absentSecretIsNotShownAndNonSecretTypesPassThrough() {
        assertThat(ConnectorConfig.mask("filehub", Map.of("baseUrl", "x"))).doesNotContainKey("apiKey");
        assertThat(ConnectorConfig.mask("iam", Map.of("baseUrl", "x", "adminUsers", "a"))).containsEntry("adminUsers", "a");
    }
}
