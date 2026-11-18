package io.reporthub.reportstudio.engine.builtin;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Child reports must receive all run params - fiscal year/quarter live on the run, not in the loopSql row.
 * If dropped, the whole book silently renders the default year with no visible error.
 */
class BookEngineChildParamsTest {

    private final Map<String, Object> run = new LinkedHashMap<>(Map.of(
            "YEAR", "2025",
            "QUARTER", "2",
            "USER", "analyst-branch15"));

    @Test
    void runParamsReachEveryChild() {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("BRANCH_REPORT", "uuid-branch");
        row.put("REGION_REPORT", "uuid-region");

        Map<String, Object> p = BookEngine.childParams(run, row);

        assertThat(p).containsEntry("YEAR", "2025")
                     .containsEntry("QUARTER", "2")
                     .containsEntry("USER", "analyst-branch15")
                     .containsEntry("BRANCH_REPORT", "uuid-branch")
                     .containsEntry("REGION_REPORT", "uuid-region");
    }

    @Test
    void rowColumnsOverrideRunValues() {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("QUARTER", "4");

        assertThat(BookEngine.childParams(run, row)).containsEntry("QUARTER", "4");
    }

    @Test
    void reservedTocNamesAreNotPassedAsParams() {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("BRANCH_REPORT", "uuid-branch");
        row.put("BOOK_LABEL", "Head Office");
        row.put("BOOK_GROUP", "Central Region");

        assertThat(BookEngine.childParams(run, row))
                .doesNotContainKeys("BOOK_LABEL", "BOOK_GROUP")
                .containsEntry("BRANCH_REPORT", "uuid-branch");
    }

    @Test
    void doesNotMutateSharedRunMap() {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("BRANCH_REPORT", "uuid-branch");

        BookEngine.childParams(run, row);

        assertThat(run).doesNotContainKey("BRANCH_REPORT").hasSize(3);
    }

    @Test
    void nullRunParamsDoNotThrow() {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("BRANCH_REPORT", "uuid-branch");

        assertThat(BookEngine.childParams(null, row)).containsExactly(Map.entry("BRANCH_REPORT", "uuid-branch"));
    }
}
