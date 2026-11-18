package io.reporthub.reportstudio.service.etl;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What a step gets to work with: the round's fiscal year, and whatever earlier steps published.
 *
 * <p>The variable map is what makes a chain more than a list of unrelated jobs — a step can read
 * "how many rows did the load write" and act on it. Values are published under the step's varName,
 * or its step number when it has none.
 */
public class StepContext {

    private final String year;
    private final String user;
    private final Map<String, Object> vars = new LinkedHashMap<>();

    public StepContext(String year, String user) {
        this.year = year;
        this.user = user;
    }

    public String year() { return year; }
    public String user() { return user; }
    public Map<String, Object> vars() { return vars; }

    public void publish(String name, Object value) {
        if (name != null && !name.isBlank()) vars.put(name.trim(), value);
    }

    /**
     * Substitute {@code {{name}}} and {@code {{name.field}}} from published values.
     *
     * <p>Deliberately does NOT touch $YEAR4/$YEAR2 — those go through
     * {@code WarehouseService.resolveYear} so year handling stays identical everywhere, including
     * for the pipelines and checks this runs but does not own.
     *
     * <p>An unknown reference is left as written rather than blanked: a statement that silently
     * turned into {@code WHERE ID = } is worse than one that fails to parse.
     */
    public String render(String text) {
        if (text == null || text.indexOf("{{") < 0) return text;
        StringBuilder out = new StringBuilder(text.length());
        int i = 0;
        while (i < text.length()) {
            int open = text.indexOf("{{", i);
            if (open < 0) { out.append(text, i, text.length()); break; }
            int close = text.indexOf("}}", open + 2);
            if (close < 0) { out.append(text, i, text.length()); break; }
            out.append(text, i, open);
            String expr = text.substring(open + 2, close).trim();
            Object v = lookup(expr);
            out.append(v == null ? text.substring(open, close + 2) : String.valueOf(v));
            i = close + 2;
        }
        return out.toString();
    }

    private Object lookup(String expr) {
        if (expr.isEmpty()) return null;
        String[] parts = expr.split("\\.");
        Object cur = vars.get(parts[0]);
        for (int i = 1; i < parts.length && cur != null; i++) {
            if (!(cur instanceof Map<?, ?> m)) return null;
            cur = m.get(parts[i]);
        }
        return cur;
    }
}
