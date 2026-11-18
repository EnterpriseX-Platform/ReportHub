package io.reporthub.reportstudio.engine.builtin;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * A book's loopSql takes run parameters as {@code :name} - they must become real JDBC binds,
 * not string concatenation (so user-entered values cannot inject SQL).
 */
class BookEngineBindNamesTest {

    private final Map<String, Object> params = new LinkedHashMap<>(Map.of(
            "FISCAL_YEAR", "2026",
            "REGION_CODE", "01000"));

    @Test
    void namesBecomePlaceholdersAndValuesKeepOrder() {
        List<Object> binds = new ArrayList<>();
        String sql = BookEngine.bindNames(
                "SELECT a FROM t WHERE fy = :FISCAL_YEAR AND region = :REGION_CODE ORDER BY 1", params, binds);

        assertThat(sql).isEqualTo("SELECT a FROM t WHERE fy = ? AND region = ? ORDER BY 1");
        assertThat(binds).containsExactly("2026", "01000");
    }

    @Test
    void sameNameTwiceIsBoundTwice() {
        List<Object> binds = new ArrayList<>();
        String sql = BookEngine.bindNames("SELECT :FISCAL_YEAR, :FISCAL_YEAR FROM dual", params, binds);

        assertThat(sql).isEqualTo("SELECT ?, ? FROM dual");
        assertThat(binds).containsExactly("2026", "2026");
    }

    @Test
    void leavesPostgresDoubleColonCastAlone() {
        List<Object> binds = new ArrayList<>();
        String sql = BookEngine.bindNames("SELECT x::text FROM t WHERE fy = :FISCAL_YEAR", params, binds);

        assertThat(sql).isEqualTo("SELECT x::text FROM t WHERE fy = ?");
        assertThat(binds).containsExactly("2026");
    }

    @Test
    void leavesQuotedTextAlone() {
        List<Object> binds = new ArrayList<>();
        String sql = BookEngine.bindNames(
                "SELECT 'at 10:30 am' AS t, \"col:1\" FROM x WHERE fy = :FISCAL_YEAR", params, binds);

        assertThat(sql).isEqualTo("SELECT 'at 10:30 am' AS t, \"col:1\" FROM x WHERE fy = ?");
        assertThat(binds).containsExactly("2026");
    }

    @Test
    void missingValueBindsNullInsteadOfFailing() {
        List<Object> binds = new ArrayList<>();
        String sql = BookEngine.bindNames("SELECT 1 FROM t WHERE q = :QUARTER", params, binds);

        assertThat(sql).isEqualTo("SELECT 1 FROM t WHERE q = ?");
        assertThat(binds).containsExactly((Object) null);
    }

    @Test
    void skipsBothCommentStyles() {
        List<Object> binds = new ArrayList<>();
        String sql = BookEngine.bindNames(
                "SELECT 1 -- mentions :FAKE_ONE in a comment\n/* and :FAKE_TWO too */ FROM t WHERE fy = :FISCAL_YEAR",
                params, binds);

        assertThat(sql).contains(":FAKE_ONE").contains(":FAKE_TWO").endsWith("fy = ?");
        assertThat(binds).containsExactly("2026");
    }
}
