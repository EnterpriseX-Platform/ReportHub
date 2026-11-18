package io.reporthub.reportstudio.util;

import org.springframework.scheduling.support.CronExpression;

/** Cron parsing that accepts both the classic 5-field form and Spring's 6-field (seconds first) form. */
public final class Cron {

    private Cron() {}

    /** {@code "m h dom mon dow"} becomes {@code "0 m h dom mon dow"}; 6-field and macros pass through. */
    public static String normalize(String cron) {
        if (cron == null) return null;
        String t = cron.trim();
        if (t.startsWith("@")) return t;
        String[] parts = t.split("\\s+");
        return parts.length == 5 ? "0 " + String.join(" ", parts) : t;
    }

    /** Parse a 5- or 6-field expression; throws IllegalArgumentException when invalid. */
    public static CronExpression parse(String cron) {
        String n = normalize(cron);
        if (n == null || n.isBlank()) throw new IllegalArgumentException("Cron expression is empty");
        if (!n.startsWith("@") && n.split("\\s+").length != 6) {
            throw new IllegalArgumentException("Cron must have 5 fields (minute hour day month weekday) or 6 fields "
                    + "(second minute hour day month weekday), e.g. \"0 2 * * *\"; got \"" + cron.trim() + "\"");
        }
        try {
            return CronExpression.parse(n);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(e.getMessage() + " - use 5 fields (minute hour day month weekday) or 6 fields (with seconds first)", e);
        }
    }
}
