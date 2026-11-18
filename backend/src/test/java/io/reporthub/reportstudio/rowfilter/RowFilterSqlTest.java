package io.reporthub.reportstudio.rowfilter;

import io.reporthub.reportstudio.iam.RhPrincipal;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RowFilterSqlTest {

    static RhPrincipal user(Map<String, String> attrs) {
        return new RhPrincipal("ann", "Ann", "iam", "acme", false, Set.of("ANALYST"), Set.of(), attrs, Map.of());
    }

    static RowFilterSql.Rule rule(String col, String op, String value) {
        return new RowFilterSql.Rule(col, op, value, "text", null, null);
    }

    static RowFilterSql.Condition compile(List<RowFilterSql.Rule> rules, RhPrincipal p) {
        return RowFilterSql.compile(rules, p, RowFilterSql.quoted("t."), v -> "?");
    }

    @Test
    void userAttributeBecomesABindValue() {
        var c = compile(List.of(rule("DEPT_CODE", "=", "${user.departmentCode}")), user(Map.of("departmentCode", "D01")));
        assertThat(c.sql()).isEqualTo("(t.\"DEPT_CODE\" = ?)");
        assertThat(c.binds()).containsExactly("D01");
    }

    @Test
    void wrapsTheSourceQuery() {
        var c = compile(List.of(rule("DEPT_CODE", "=", "${user.departmentCode}"), rule("TENANT", "=", "${user.tenant}")),
                user(Map.of("departmentCode", "D01")));
        String sql = RowFilterSql.wrap("SELECT * FROM sales;", c);
        assertThat(sql).isEqualTo("SELECT * FROM (SELECT * FROM sales\n) rf_q WHERE (t.\"DEPT_CODE\" = ?) AND (t.\"TENANT\" = ?)");
        assertThat(c.binds()).containsExactly("D01", "acme");
    }

    @Test
    void injectionInAUserAttributeStaysInsideTheBind() {
        String evil = "D01' OR '1'='1";
        var c = compile(List.of(rule("DEPT_CODE", "=", "${user.departmentCode}")), user(Map.of("departmentCode", evil)));
        assertThat(c.sql()).doesNotContain("OR").doesNotContain("'");
        assertThat(c.binds()).containsExactly(evil);
    }

    @Test
    void injectionInAnInListStaysInsideTheBinds() {
        var c = compile(List.of(rule("DEPT", "IN", "${user.depts}")), user(Map.of("depts", "A, B);DROP TABLE x;--")));
        assertThat(c.sql()).isEqualTo("(t.\"DEPT\" IN (?, ?))");
        assertThat(c.binds()).containsExactly("A", "B);DROP TABLE x;--");
    }

    @Test
    void columnNamesAreValidated() {
        assertThatThrownBy(() -> compile(List.of(rule("DEPT\" = 1 OR \"X", "=", "a")), user(Map.of())))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> compile(List.of(rule("a b", "=", "a")), user(Map.of())))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void operatorsComeFromAFixedList() {
        assertThatThrownBy(() -> compile(List.of(rule("A", "= 1 OR 1 =", "a")), user(Map.of())))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(RowFilterSql.normalizeOperator(" not   in ")).isEqualTo("NOT IN");
        assertThat(RowFilterSql.normalizeOperator("!=")).isEqualTo("<>");
    }

    @Test
    void missingAttributeDeniesInsteadOfDroppingTheFilter() {
        var c = compile(List.of(rule("DEPT_CODE", "=", "${user.departmentCode}")), user(Map.of()));
        assertThat(c.sql()).isEqualTo("(1=0)");
        assertThat(c.binds()).isEmpty();
    }

    @Test
    void numberValuesAreCoerced() {
        var r = new RowFilterSql.Rule("LEVEL", "<=", "${user.level}", "number", null, null);
        var c = compile(List.of(r), user(Map.of("level", "5")));
        assertThat(c.binds()).containsExactly(new BigDecimal("5"));
        assertThatThrownBy(() -> compile(List.of(r), user(Map.of("level", "5 OR 1=1"))))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void literalAndTemplateValuesMix() {
        var c = compile(List.of(rule("CODE", "LIKE", "${user.departmentCode}-%")), user(Map.of("departmentCode", "D01")));
        assertThat(c.binds()).containsExactly("D01-%");
    }

    @Test
    void nullChecksTakeNoValue() {
        var c = compile(List.of(rule("CLOSED_AT", "IS NULL", null)), user(Map.of()));
        assertThat(c.sql()).isEqualTo("(t.\"CLOSED_AT\" IS NULL)");
    }

    @Test
    void principalScopedRulesOnlyApplyToThem() {
        var forManagers = new RowFilterSql.Rule("A", "=", "x", "text", "role", "MANAGER");
        var forAnalysts = new RowFilterSql.Rule("B", "=", "y", "text", "role", "ANALYST");
        var c = compile(List.of(forManagers, forAnalysts), user(Map.of()));
        assertThat(c.sql()).isEqualTo("(t.\"B\" = ?)");
    }

    @Test
    void noRulesNoPrincipalNoChange() {
        assertThat(compile(List.of(), user(Map.of())).isEmpty()).isTrue();
        assertThat(compile(List.of(rule("A", "=", "x")), null).isEmpty()).isTrue();
        assertThat(RowFilterSql.wrap("SELECT 1", RowFilterSql.NONE)).isEqualTo("SELECT 1");
    }

    @Test
    void trailingLineCommentCannotSwallowTheWrapper() {
        var c = compile(List.of(rule("A", "=", "x")), user(Map.of()));
        assertThat(RowFilterSql.wrap("SELECT * FROM t -- note", c)).contains("-- note\n) rf_q WHERE");
    }

    @Test
    void namedPlaceholdersForTheRenderEngines() {
        int[] n = {0};
        var c = RowFilterSql.compile(List.of(rule("A", "IN", "x,y")), user(Map.of()),
                RowFilterSql.quoted(""), v -> "$P{__rf" + (n[0]++) + "}");
        assertThat(c.sql()).isEqualTo("(\"A\" IN ($P{__rf0}, $P{__rf1}))");
    }
}
