package io.reporthub.reportstudio.web;

import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import io.reporthub.reportstudio.dto.ReportCodeNameDto;
import io.reporthub.reportstudio.service.ReportService;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * GET /reports/codes is consumed by other apps, so the exact JSON — key names, key order and a
 * bare array (no paging envelope) — is the contract and is asserted literally. Thai names are read
 * back as UTF-8 explicitly: MockHttpServletResponse defaults to ISO-8859-1 when the converter
 * writes {@code application/json} without a charset.
 */
class ReportCodeListApiTest {

    @Test
    void returnsAFlatCodeNameArray() throws Exception {
        ReportService service = mock(ReportService.class);
        when(service.codeList(null)).thenReturn(List.of(
                new ReportCodeNameDto("RPT-002", "Monthly sales by branch"),
                new ReportCodeNameDto("RPT-006", "Quarterly sales summary")));
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ReportController(service)).build();

        String body = mvc.perform(get("/reports/codes"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        assertThat(body).isEqualTo("[{\"code\":\"RPT-002\",\"name\":\"Monthly sales by branch\"},"
                + "{\"code\":\"RPT-006\",\"name\":\"Quarterly sales summary\"}]");
    }
}
