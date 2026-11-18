package io.reporthub.reportstudio.engine.builtin;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * loopSql column name = the parameter name the child report receives.
 *
 * <p>Oracle returns unquoted aliases in upper case, Postgres in lower case, so they are normalised -
 * but deliberately quoted camelCase names must survive (some child reports take camelCase parameters;
 * upper-cased to BRANCHREPORT they would match nothing and the child would silently get an empty value).
 */
class BookEngineColumnKeyTest {

    @Test
    void plainAliasIsUpperCasedWhateverTheDatabase() {
        assertThat(BookEngine.columnKey("BRANCH_REPORT", 1)).isEqualTo("BRANCH_REPORT");   // Oracle
        assertThat(BookEngine.columnKey("branch_report", 1)).isEqualTo("BRANCH_REPORT");   // Postgres
    }

    @Test
    void mixedCaseNameIsKeptBecauseItWasQuoted() {
        assertThat(BookEngine.columnKey("branchReport", 1)).isEqualTo("branchReport");
        assertThat(BookEngine.columnKey("yearTh", 2)).isEqualTo("yearTh");
    }

    @Test
    void unnamedColumnGetsPositionalKey() {
        assertThat(BookEngine.columnKey(null, 3)).isEqualTo("C3");
        assertThat(BookEngine.columnKey("  ", 4)).isEqualTo("C4");
    }

    @Test
    void reservedTocNamesAreRemovedInAnyCase() {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("book_label", "Head Office");     // as Postgres returns it
        row.put("BOOK_GROUP", "Central Region");
        row.put("branchReport", "uuid-branch");

        assertThat(BookEngine.childParams(Map.of("YEAR", "2025"), row))
                .containsOnlyKeys("YEAR", "branchReport");
    }
}
