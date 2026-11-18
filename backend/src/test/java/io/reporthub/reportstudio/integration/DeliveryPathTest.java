package io.reporthub.reportstudio.integration;

import org.junit.jupiter.api.Test;

import java.time.LocalDate;

import static org.assertj.core.api.Assertions.assertThat;

class DeliveryPathTest {

    private static final LocalDate D = LocalDate.of(2026, 3, 7);

    @Test
    void replacesPlaceholders() {
        assertThat(DeliveryPath.render("{code}/{yyyy}/{mm}", "RPT-001", D)).isEqualTo("RPT-001/2026/03");
        assertThat(DeliveryPath.render("reports/{yyyy}-{mm}-{dd}", "X", D)).isEqualTo("reports/2026-03-07");
    }

    @Test
    void normalisesSlashesAndUnsafeSegments() {
        assertThat(DeliveryPath.render("/a//../{code}/./", "A/B C", D)).isEqualTo("a/A_B_C");
        assertThat(DeliveryPath.render("  ", "X", D)).isEmpty();
        assertThat(DeliveryPath.render(null, "X", D)).isEmpty();
    }
}
