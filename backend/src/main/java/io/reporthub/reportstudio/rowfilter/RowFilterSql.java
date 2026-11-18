package io.reporthub.reportstudio.rowfilter;

import io.reporthub.reportstudio.iam.RhPrincipal;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Compiles row-filter rules into a SQL condition. Pure and stateless so it can be unit tested.
 *
 * <p>Safety: column names must be plain identifiers and are double-quoted (or resolved by the
 * caller against the real catalog); operators come from a fixed list; every value — including
 * values taken from the user's IAM attributes — is a bind parameter produced by {@code ph}.
 * Nothing user-controlled is ever concatenated into the statement.
 */
public final class RowFilterSql {

    /** Rule shape the compiler needs (entity or preview input). */
    public record Rule(String column, String operator, String valueExpr, String valueType,
                       String principalType, String principalCode) {}

    /** {@code sql} uses whatever placeholders {@code ph} produced; {@code binds} in order. */
    public record Condition(String sql, List<Object> binds) {
        public boolean isEmpty() { return sql == null || sql.isEmpty(); }
    }

    public static final Set<String> OPERATORS = Set.of(
            "=", "<>", "!=", "<", "<=", ">", ">=", "IN", "NOT IN", "LIKE", "IS NULL", "IS NOT NULL");

    public static final Condition NONE = new Condition("", List.of());

    private static final Pattern IDENT = Pattern.compile("[A-Za-z_][A-Za-z0-9_$#]{0,127}");
    private static final Pattern VAR = Pattern.compile("\\$\\{user\\.([A-Za-z0-9_.-]{1,64})}");
    private static final int MAX_IN = 1000;

    private RowFilterSql() {}

    public static boolean validColumn(String c) {
        return c != null && IDENT.matcher(c).matches();
    }

    public static String normalizeOperator(String op) {
        String o = op == null ? "" : op.trim().toUpperCase(Locale.ROOT).replaceAll("\\s+", " ");
        if (!OPERATORS.contains(o)) throw new IllegalArgumentException("Unsupported operator: " + op);
        return "!=".equals(o) ? "<>" : o;
    }

    /** Default column rendering: validated and double-quoted, prefixed by {@code alias}. */
    public static Function<String, String> quoted(String alias) {
        String a = alias == null ? "" : alias;
        return c -> {
            if (!validColumn(c)) throw new IllegalArgumentException("Invalid column name: " + c);
            return a + "\"" + c + "\"";
        };
    }

    /** True when the rule targets this caller (no principal = everyone). */
    public static boolean appliesTo(Rule r, RhPrincipal p) {
        if (r.principalType() == null || r.principalType().isBlank()) return true;
        String code = r.principalCode();
        return switch (r.principalType().toLowerCase(Locale.ROOT)) {
            case "role" -> p.roles().contains(code);
            case "responsibility" -> p.responsibilities().contains(code);
            case "user" -> p.username().equals(code);
            default -> false;
        };
    }

    /**
     * AND of all rules applying to {@code p}. A rule whose expression names an attribute the user
     * does not have compiles to {@code 1=0} (deny), never to "no filter".
     *
     * @param column renders a validated column reference (throws on unknown columns)
     * @param ph     records a bind value and returns its placeholder ({@code ?} or {@code $P{..}})
     */
    public static Condition compile(List<Rule> rules, RhPrincipal p,
                                    Function<String, String> column, Function<Object, String> ph) {
        if (rules == null || rules.isEmpty() || p == null) return NONE;
        List<String> parts = new ArrayList<>();
        List<Object> binds = new ArrayList<>();
        Function<Object, String> rec = v -> { binds.add(v); return ph.apply(v); };
        for (Rule r : rules) {
            if (!appliesTo(r, p)) continue;
            parts.add(one(r, p, column, rec));
        }
        if (parts.isEmpty()) return NONE;
        return new Condition(String.join(" AND ", parts), binds);
    }

    private static String one(Rule r, RhPrincipal p, Function<String, String> column, Function<Object, String> ph) {
        String col = column.apply(r.column());
        String op = normalizeOperator(r.operator());
        if (op.equals("IS NULL") || op.equals("IS NOT NULL")) return "(" + col + " " + op + ")";

        String resolved = resolve(r.valueExpr(), p);
        if (resolved == null) return "(1=0)";
        boolean number = "number".equalsIgnoreCase(r.valueType());

        if (op.equals("IN") || op.equals("NOT IN")) {
            List<String> items = new ArrayList<>();
            for (String s : resolved.split(",")) if (!s.isBlank()) items.add(s.trim());
            if (items.isEmpty()) return op.equals("IN") ? "(1=0)" : "(1=1)";
            if (items.size() > MAX_IN) throw new IllegalArgumentException("Too many values in IN list");
            List<String> phs = new ArrayList<>();
            for (String s : items) phs.add(ph.apply(coerce(s, number)));
            return "(" + col + " " + op + " (" + String.join(", ", phs) + "))";
        }
        return "(" + col + " " + op + " " + ph.apply(coerce(resolved, number)) + ")";
    }

    /** Substitute {@code ${user.x}}; null when a referenced attribute is missing or blank. */
    public static String resolve(String expr, RhPrincipal p) {
        if (expr == null) return null;
        Matcher m = VAR.matcher(expr);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String v = p.attribute(m.group(1));
            if (v == null || v.isBlank()) return null;
            m.appendReplacement(out, Matcher.quoteReplacement(v));
        }
        m.appendTail(out);
        return out.toString();
    }

    private static Object coerce(String v, boolean number) {
        if (!number) return v;
        try {
            return new BigDecimal(v.trim());
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Not a number: " + v);
        }
    }

    /** {@code SELECT * FROM (<sql>) rf_q WHERE <cond>} — or {@code sql} unchanged when there is no condition. */
    public static String wrap(String sql, Condition c) {
        if (c == null || c.isEmpty()) return sql;
        String inner = sql.strip();
        while (inner.endsWith(";")) inner = inner.substring(0, inner.length() - 1).strip();
        // newline before ")" so a trailing line comment in the source query cannot swallow it
        return "SELECT * FROM (" + inner + "\n) rf_q WHERE " + c.sql();
    }
}
