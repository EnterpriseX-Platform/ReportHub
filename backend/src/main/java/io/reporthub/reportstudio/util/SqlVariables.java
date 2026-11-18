package io.reporthub.reportstudio.util;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Finds {@code $NAME} and {@code :name} variables in hand-written SQL and turns them into JDBC
 * {@code ?} placeholders, so their values are bound - never spliced into the statement.
 *
 * <p>String literals, quoted identifiers, comments and dollar-quoted bodies are skipped, as are
 * Postgres casts ({@code ::type}), PL/SQL assignment ({@code :=}) and positional {@code $1}.
 */
public final class SqlVariables {

    private SqlVariables() {}

    /** The rewritten statement and the variable name for each {@code ?}, in order. */
    public record Parsed(String sql, List<String> names) {
        public boolean hasVariables() { return !names.isEmpty(); }
    }

    /** The statement plus the values to bind, in placeholder order. */
    public record Bound(String sql, List<Object> values) {}

    public static Parsed parse(String sql) {
        StringBuilder out = new StringBuilder(sql.length());
        List<String> names = new ArrayList<>();
        int n = sql.length();
        int i = 0;
        while (i < n) {
            char c = sql.charAt(i);
            char nx = i + 1 < n ? sql.charAt(i + 1) : '\0';
            if (c == '\'' || c == '"') {
                int j = i + 1;
                while (j < n) {
                    if (sql.charAt(j) == c) {
                        if (j + 1 < n && sql.charAt(j + 1) == c) { j += 2; continue; }
                        break;
                    }
                    j++;
                }
                j = Math.min(j + 1, n);
                out.append(sql, i, j);
                i = j;
            } else if (c == '-' && nx == '-') {
                int j = sql.indexOf('\n', i);
                j = j < 0 ? n : j;
                out.append(sql, i, j);
                i = j;
            } else if (c == '/' && nx == '*') {
                int j = sql.indexOf("*/", i + 2);
                j = j < 0 ? n : j + 2;
                out.append(sql, i, j);
                i = j;
            } else if (c == '$' && (nx == '$' || Character.isLetter(nx) || nx == '_') && dollarTagEnd(sql, i) > 0) {
                // dollar-quoted body: $$ ... $$ or $tag$ ... $tag$
                int tagEnd = dollarTagEnd(sql, i);
                String tag = sql.substring(i, tagEnd);
                int close = sql.indexOf(tag, tagEnd);
                int j = close < 0 ? n : close + tag.length();
                out.append(sql, i, j);
                i = j;
            } else if ((c == '$' || c == ':') && (Character.isLetter(nx) || nx == '_')
                    && !(c == ':' && i > 0 && sql.charAt(i - 1) == ':')) {
                int j = i + 1;
                while (j < n && (Character.isLetterOrDigit(sql.charAt(j)) || sql.charAt(j) == '_')) j++;
                names.add(sql.substring(i + 1, j));
                out.append('?');
                i = j;
            } else {
                out.append(c);
                i++;
            }
        }
        return new Parsed(out.toString(), names);
    }

    /** Index just past a {@code $tag$} opener at {@code i}, or -1 when this is a {@code $NAME} variable. */
    private static int dollarTagEnd(String sql, int i) {
        int j = i + 1;
        while (j < sql.length() && (Character.isLetterOrDigit(sql.charAt(j)) || sql.charAt(j) == '_')) j++;
        return j < sql.length() && sql.charAt(j) == '$' ? j + 1 : -1;
    }

    /**
     * Rewrite and bind. Names match case-insensitively. Throws {@link IllegalArgumentException}
     * listing every variable without a value.
     */
    public static Bound bind(String sql, Map<String, ?> values) {
        Parsed p = parse(sql);
        if (!p.hasVariables()) return new Bound(sql, List.of());
        Map<String, Object> ci = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        if (values != null) values.forEach((k, v) -> {
            // Accept ":name" / "$NAME" keys as well as bare names
            String key = k != null && (k.startsWith(":") || k.startsWith("$")) ? k.substring(1) : k;
            if (key != null && (v != null || !ci.containsKey(key))) ci.put(key, v);
        });
        Set<String> missing = new LinkedHashSet<>();
        List<Object> out = new ArrayList<>();
        for (String name : p.names()) {
            if (!ci.containsKey(name) || ci.get(name) == null) missing.add(name);
            else out.add(ci.get(name));
        }
        if (!missing.isEmpty()) {
            throw new IllegalArgumentException("Missing value for SQL variable(s): " + String.join(", ", missing));
        }
        return new Bound(p.sql(), out);
    }
}
