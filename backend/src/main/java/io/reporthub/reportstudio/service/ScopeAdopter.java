package io.reporthub.reportstudio.service;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Rewrites a rule's SQL to reference the group's scope via {@code $SCOPE} instead of repeating the
 * table and shared conditions itself.
 *
 * <p>The one rule of this converter is <b>never guess</b> — it only touches exact matches. A rule that
 * does not qualify is skipped with a reason; that is better than a wrong rewrite that silently skews results:
 * <ul>
 *   <li>The table in the rule must match the scope's source and appear <b>exactly once</b> in the query
 *       — several occurrences (subquery/self-join) mean replacing it would change the inner query too.</li>
 *   <li>Only conditions identical to a shared condition (ignoring whitespace and case) are removed.</li>
 *   <li>The result must pass the existing SQL validator, otherwise the conversion fails.</li>
 * </ul>
 */
public final class ScopeAdopter {

    private ScopeAdopter() {}

    /** Result of converting one rule. */
    public record Result(Long id, String name, boolean changed, String reason, String before, String after) {}

    private static String norm(String s) {
        return s.replaceAll("\\s+", "").toUpperCase(Locale.ROOT);
    }

    /**
     * A copy of the query with quoted text and comments blanked to spaces, keeping <b>exactly the same length</b>.
     *
     * <p>This is the key piece: the existing helper ({@code DatasetService.codeOnly}) collapses whitespace,
     * so character offsets drift from the original and splicing with them cuts in the wrong place
     * (producing garbage like {@code WHERE YEAR = '$Y AND AND REGION = AND AND ...}).
     * Here each character is replaced one-for-one so indexes in the mask apply to the original verbatim.
     */
    static String mask(String sql) {
        char[] out = sql.toCharArray();
        int n = sql.length();
        int i = 0;
        while (i < n) {
            char c = sql.charAt(i);
            if (c == '\'' || c == '"') {                       // string literal / quoted identifier
                char q = c;
                out[i++] = ' ';
                while (i < n) {
                    if (sql.charAt(i) == q) {
                        if (q == '\'' && i + 1 < n && sql.charAt(i + 1) == '\'') { out[i++] = ' '; out[i++] = ' '; continue; }
                        out[i++] = ' ';
                        break;
                    }
                    out[i++] = ' ';
                }
            } else if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-') {      // line comment
                while (i < n && sql.charAt(i) != '\n') out[i++] = ' ';
            } else if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {      // block comment
                out[i++] = ' '; out[i++] = ' ';
                while (i + 1 < n && !(sql.charAt(i) == '*' && sql.charAt(i + 1) == '/')) out[i++] = ' ';
                if (i + 1 < n) { out[i++] = ' '; out[i++] = ' '; }
            } else {
                i++;
            }
        }
        return new String(out);
    }

    /** Spans of every {@code FROM <table>} occurrence (outside strings/comments). */
    private static List<int[]> fromSpans(String mask, String table) {
        List<int[]> out = new ArrayList<>();
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("(?i)\\bFROM\\s+" + java.util.regex.Pattern.quote(table) + "\\b")
                .matcher(mask);
        while (m.find()) out.add(new int[]{m.start(), m.end()});
        return out;
    }

    /**
     * Converts one rule — {@code after} is null when it cannot be converted (see {@code reason}).
     *
     * @param table      the scope's source (must be a table name, not a SELECT)
     * @param conditions the scope's shared conditions
     */
    public static Result convert(Long id, String name, String sql, String table, List<String> conditions) {
        if (sql == null || sql.isBlank()) return new Result(id, name, false, "No SQL", sql, null);
        if (sql.contains("$SCOPE")) return new Result(id, name, false, "Already uses $SCOPE", sql, null);

        String mask = mask(sql);
        List<int[]> spans = fromSpans(mask, table);
        if (spans.isEmpty()) return new Result(id, name, false, "Does not read from " + table, sql, null);
        if (spans.size() > 1) {
            return new Result(id, name, false,
                    "Reads " + table + " " + spans.size() + " times in one query — replacing it would change the inner query too",
                    sql, null);
        }

        // ① FROM <table> → FROM $SCOPE
        int[] sp = spans.get(0);
        String out = sql.substring(0, sp[0]) + "FROM $SCOPE" + sql.substring(sp[1]);

        // ② Drop shared conditions from the outer WHERE — they now live inside $SCOPE
        int removed = 0;
        if (!conditions.isEmpty()) {
            String m2 = mask(out);
            int w = topLevelWhere(m2);
            if (w >= 0) {
                int end = clauseEnd(m2, w);
                List<int[]> terms = splitTopLevelAnd(m2, w, end);
                List<String> keep = new ArrayList<>();
                for (int[] t : terms) {
                    String raw = out.substring(t[0], t[1]).trim();
                    if (raw.isEmpty()) continue;
                    if (conditions.stream().anyMatch(c -> norm(c).equals(norm(raw)))) { removed++; continue; }
                    keep.add(raw);
                }
                // Always break the line before AND so a term ending in a -- comment does not swallow the next AND
                String rebuilt = keep.isEmpty() ? "" : "WHERE " + String.join("\n  AND ", keep) + "\n";
                out = out.substring(0, w) + rebuilt + out.substring(end);
            }
        }

        try {
            DatasetService.validateSql(out);
        } catch (RuntimeException e) {
            return new Result(id, name, false, "Converted SQL failed validation: " + e.getMessage(), sql, null);
        }
        return new Result(id, name, true,
                "Replaced FROM with $SCOPE" + (removed > 0 ? " · removed " + removed + " shared condition(s)" : ""),
                sql, out);
    }

    /** Position of the outermost WHERE (outside parentheses), or -1 if none. */
    private static int topLevelWhere(String mask) {
        int depth = 0;
        for (int i = 0; i < mask.length(); i++) {
            char ch = mask.charAt(i);
            if (ch == '(') depth++;
            else if (ch == ')') depth--;
            else if (depth == 0 && mask.regionMatches(true, i, "WHERE", 0, 5)
                     && (i == 0 || !isWord(mask.charAt(i - 1)))
                     && (i + 5 >= mask.length() || !isWord(mask.charAt(i + 5)))) {
                return i;
            }
        }
        return -1;
    }

    private static boolean isWord(char c) { return Character.isLetterOrDigit(c) || c == '_'; }

    /** End of the outer WHERE — the next top-level GROUP/ORDER/HAVING/UNION/FETCH/OFFSET, or end of text. */
    private static int clauseEnd(String mask, int whereAt) {
        String[] stops = {"GROUP", "ORDER", "HAVING", "UNION", "FETCH", "OFFSET", "MINUS", "INTERSECT"};
        int depth = 0;
        for (int i = whereAt + 5; i < mask.length(); i++) {
            char ch = mask.charAt(i);
            if (ch == '(') depth++;
            else if (ch == ')') depth--;
            else if (depth == 0 && !isWord(mask.charAt(i - 1))) {
                for (String s : stops) {
                    if (mask.regionMatches(true, i, s, 0, s.length())
                        && (i + s.length() >= mask.length() || !isWord(mask.charAt(i + s.length())))) return i;
                }
            }
        }
        return mask.length();
    }

    /** Splits WHERE terms on top-level AND — returns [start, end) of each term. */
    private static List<int[]> splitTopLevelAnd(String mask, int whereAt, int end) {
        List<int[]> out = new ArrayList<>();
        int depth = 0;
        int start = whereAt + 5;                       // skip the WHERE keyword
        for (int i = start; i < end; i++) {
            char ch = mask.charAt(i);
            if (ch == '(') depth++;
            else if (ch == ')') depth--;
            else if (depth == 0 && mask.regionMatches(true, i, "AND", 0, 3)
                     && !isWord(mask.charAt(i - 1))
                     && (i + 3 >= end || !isWord(mask.charAt(i + 3)))) {
                out.add(new int[]{start, i});
                start = i + 3;
                i += 2;
            }
        }
        out.add(new int[]{start, end});
        return out;
    }
}
