package io.reporthub.reportstudio.util;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.sql.Types;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TypedValuesTest {

    @Test
    void coercesTextToColumnTypes() {
        assertThat(TypedValues.coerce("42", Types.INTEGER)).isEqualTo(42);
        assertThat(TypedValues.coerce("1,234.5", Types.NUMERIC)).isEqualTo(new BigDecimal("1234.5"));
        assertThat(TypedValues.coerce("yes", Types.BOOLEAN)).isEqualTo(Boolean.TRUE);
        assertThat(TypedValues.coerce("2026-01-31", Types.DATE)).isEqualTo(java.sql.Date.valueOf("2026-01-31"));
        assertThat(TypedValues.coerce("2026-01-31T10:15:00", Types.TIMESTAMP))
                .isEqualTo(java.sql.Timestamp.valueOf("2026-01-31 10:15:00"));
        assertThat(TypedValues.coerce("2026-01-31", Types.TIMESTAMP))
                .isEqualTo(java.sql.Timestamp.valueOf("2026-01-31 00:00:00"));
        assertThat(TypedValues.coerce("", Types.INTEGER)).isNull();
        assertThat(TypedValues.coerce("", Types.VARCHAR)).isEqualTo("");
        assertThat(TypedValues.coerce("abc", Types.INTEGER)).isEqualTo("abc");   // DB reports the error
        assertThat(TypedValues.coerce(5, Types.VARCHAR)).isEqualTo(5);
    }

    @Test
    void sqlVariablesBecomeBinds() {
        var b = SqlVariables.bind("SELECT * FROM t WHERE a = $YEAR AND b = :name AND c = 'x:y $Z' AND d::int > 1 -- :c",
                Map.of("year", "2026", "NAME", "n"));
        assertThat(b.sql()).isEqualTo("SELECT * FROM t WHERE a = ? AND b = ? AND c = 'x:y $Z' AND d::int > 1 -- :c");
        assertThat(b.values()).containsExactly("2026", "n");
        assertThatThrownBy(() -> SqlVariables.bind("SELECT :a, $B", Map.of()))
                .hasMessageContaining("a, B");
        assertThat(SqlVariables.parse("DO $$ BEGIN x := :v; END $$").names()).isEmpty();
    }

    @Test
    void cronAcceptsFiveFields() {
        assertThat(Cron.normalize("*/5 * * * *")).isEqualTo("0 */5 * * * *");
        assertThat(Cron.normalize("0 0 1 * * *")).isEqualTo("0 0 1 * * *");
        assertThat(Cron.parse("30 2 * * 1")).isNotNull();
    }
}
