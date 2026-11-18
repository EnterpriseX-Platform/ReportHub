package io.reporthub.reportstudio.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.reporthub.reportstudio.document.DocumentControllerAccess;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class E2eRound1WebTest {

    @Test
    void retryOnlyForFailedOrCancelled() {
        assertThat(RunController.isRetryable("error")).isTrue();
        assertThat(RunController.isRetryable("cancelled")).isTrue();
        assertThat(RunController.isRetryable("done")).isFalse();
        assertThat(RunController.isRetryable("running")).isFalse();
    }

    @Test
    void runFormatMustBeDeclared() {
        assertThat(RunController.resolveFormat("pdf", "PDF,XLSX")).isEqualTo("PDF");
        assertThat(RunController.resolveFormat(null, "XLSX,PDF")).isEqualTo("XLSX");
        assertThatThrownBy(() -> RunController.resolveFormat("DOCX", "PDF")).isInstanceOf(BadRequestException.class);
    }

    @Test
    void registrySortIsWhitelisted() {
        assertThat(ReportController.parseSort("name,asc")).isNotNull();
        assertThatThrownBy(() -> ReportController.parseSort("bogus,asc")).isInstanceOf(BadRequestException.class);
    }

    @Test
    void flowStagesOutsidePipelineAreFlagged() throws Exception {
        var doc = new ObjectMapper().readTree("{\"nodes\":[{\"id\":\"q\",\"data\":{\"kind\":\"queue\"}},"
                + "{\"id\":\"n\",\"data\":{\"kind\":\"notify\",\"label\":\"Notify\"}}]}");
        assertThat(FlowController.markExecution(doc)).containsExactly("Notify");
        assertThat(doc.path("nodes").get(0).path("data").path("executed").asBoolean()).isTrue();
        assertThat(doc.path("nodes").get(1).path("data").path("executed").asBoolean()).isFalse();
    }

    @Test
    void documentContentValidated() throws Exception {
        ObjectMapper m = new ObjectMapper();
        DocumentControllerAccess.validate(m.readTree(DocumentControllerAccess.defaultContent()));
        assertThatThrownBy(() -> DocumentControllerAccess.validate(m.readTree("{\"sections\":[]}")))
                .hasMessageContaining("page");
        assertThatThrownBy(() -> DocumentControllerAccess.validate(m.readTree(
                "{\"page\":{\"size\":\"a4\",\"orientation\":\"sideways\",\"marginsMm\":{\"top\":1,\"right\":1,\"bottom\":1,\"left\":1}},\"sections\":[]}")))
                .hasMessageContaining("orientation");
        assertThatThrownBy(() -> DocumentControllerAccess.validate(m.readTree(
                "{\"page\":{\"size\":\"a4\",\"orientation\":\"portrait\",\"marginsMm\":{\"top\":200,\"right\":1,\"bottom\":200,\"left\":1}},\"sections\":[]}")))
                .hasMessageContaining("no room");
    }
}
