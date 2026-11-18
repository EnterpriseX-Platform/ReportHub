package io.reporthub.reportstudio.rowfilter;

import io.reporthub.reportstudio.iam.CurrentPrincipal;
import io.reporthub.reportstudio.iam.RhPrincipal;
import org.springframework.stereotype.Service;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * Applies level-3 row filters for the current caller. Administrators and callers with no
 * principal (system timers) are not filtered.
 */
@Service
public class RowFilterService {

    public static final String REPORT = "REPORT", DATASET = "DATASET", REPO_TABLE = "REPO_TABLE";

    private final RowFilterRuleRepository rules;

    public RowFilterService(RowFilterRuleRepository rules) {
        this.rules = rules;
    }

    /** The caller rules apply to, or null when nothing should be filtered. */
    public static RhPrincipal subject() {
        RhPrincipal p = CurrentPrincipal.get().orElse(null);
        return p == null || p.admin() ? null : p;
    }

    public List<RowFilterSql.Rule> rulesFor(String type, Collection<String> ids) {
        if (ids == null || ids.isEmpty()) return List.of();
        return rules.findByObjectTypeAndObjectIdInAndEnabledTrueOrderById(type, ids).stream()
                .map(RowFilterService::toRule).toList();
    }

    public static RowFilterSql.Rule toRule(RowFilterRule r) {
        return new RowFilterSql.Rule(r.getColumnName(), r.getOperator(), r.getValueExpr(), r.getValueType(),
                r.getPrincipalType(), r.getPrincipalCode());
    }

    /** Condition for the current caller; {@link RowFilterSql#NONE} when unfiltered. */
    public RowFilterSql.Condition condition(String type, Collection<String> ids,
                                            Function<String, String> column, Function<Object, String> ph) {
        RhPrincipal p = subject();
        if (p == null) return RowFilterSql.NONE;
        List<RowFilterSql.Rule> rs = rulesFor(type, ids);
        if (rs.isEmpty()) return RowFilterSql.NONE;
        return RowFilterSql.compile(rs, p, column, ph);
    }

    /** Wrapped SQL using {@code ?} binds; {@code binds} must be bound before any outer ones. */
    public RowFilterSql.Condition wrapJdbc(String type, String id, String sql, List<Object> bindsOut) {
        RowFilterSql.Condition c = condition(type, List.of(id), RowFilterSql.quoted("rf_q."), v -> "?");
        bindsOut.addAll(c.binds());
        return new RowFilterSql.Condition(RowFilterSql.wrap(sql, c), c.binds());
    }

    /**
     * Wrap a report's SQL for the render engines, which bind {@code $P{name}} placeholders from the
     * parameter map: filter values are added to {@code params} as {@code __rf<n>}.
     */
    public String wrapForRender(String reportCode, String sql, Map<String, Object> params) {
        if (sql == null || sql.isBlank()) return sql;
        int[] n = {0};
        RowFilterSql.Condition c = condition(REPORT, List.of(reportCode), RowFilterSql.quoted("rf_q."), v -> {
            String name = "__rf" + (n[0]++);
            params.put(name, v);
            return "$P{" + name + "}";
        });
        return RowFilterSql.wrap(sql, c);
    }
}
