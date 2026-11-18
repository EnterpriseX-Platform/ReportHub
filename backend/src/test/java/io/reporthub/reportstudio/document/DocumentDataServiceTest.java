package io.reporthub.reportstudio.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class DocumentDataServiceTest {

    @Test
    void fillReplacesKnownParamsAndBlanksUnknown() {
        assertThat(DocumentDataService.fill("{{year}}-{{ quarter }}/{{missing}}", Map.of("year", "2025", "quarter", "Q2")))
                .isEqualTo("2025-Q2/");
    }

    @Test
    void effectiveParamsOverlaysSuppliedOnDefaults() throws Exception {
        DocumentDataService svc = new DocumentDataService(new ObjectMapper(), null, null);
        var content = new ObjectMapper().readTree("{\"params\":[{\"name\":\"year\",\"defaultValue\":\"2024\"},{\"name\":\"region\"}]}");
        assertThat(svc.effectiveParams(content, Map.of("region", "North")))
                .containsEntry("year", "2024").containsEntry("region", "North");
    }

    @Test
    void resolveSkipsUnboundBlocks() {
        DocumentDataService svc = new DocumentDataService(new ObjectMapper(), null, null);
        assertThat(svc.resolve("{\"sections\":[{\"blocks\":[{\"id\":\"a\",\"type\":\"table\"}]}]}", Map.of())).isEmpty();
    }
}
