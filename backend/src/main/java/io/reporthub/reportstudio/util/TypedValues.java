package io.reporthub.reportstudio.util;

import java.math.BigDecimal;
import java.sql.ParameterMetaData;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Types;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Locale;

/**
 * Turns text values that arrive from the UI into the Java type matching a column's JDBC type,
 * so strict drivers (Postgres does not cast varchar to integer/date implicitly) accept the bind.
 * Oracle accepts the typed values as well, so one code path serves both.
 *
 * <p>Values that cannot be parsed are passed through unchanged; the database then reports a
 * clear type error instead of the value being silently dropped.
 */
public final class TypedValues {

    private TypedValues() {}

    /** Coerce one value to {@code sqlType} ({@link java.sql.Types}). Non-strings are returned as-is. */
    public static Object coerce(Object v, int sqlType) {
        if (!(v instanceof String s)) return v;
        String t = s.trim();
        if (t.isEmpty()) {
            return isText(sqlType) ? s : null;   // "" in a number/date cell means "no value"
        }
        try {
            return switch (sqlType) {
                case Types.TINYINT, Types.SMALLINT, Types.INTEGER -> Integer.valueOf(stripNumber(t));
                case Types.BIGINT -> Long.valueOf(stripNumber(t));
                case Types.DECIMAL, Types.NUMERIC -> new BigDecimal(stripNumber(t));
                case Types.REAL, Types.FLOAT, Types.DOUBLE -> Double.valueOf(stripNumber(t));
                case Types.BIT, Types.BOOLEAN -> bool(t, s);
                case Types.DATE -> date(t);
                case Types.TIMESTAMP -> timestamp(t);
                case Types.TIMESTAMP_WITH_TIMEZONE -> OffsetDateTime.parse(t.replace(' ', 'T'));
                case Types.TIME -> LocalTime.parse(t);
                default -> s;
            };
        } catch (NumberFormatException | DateTimeParseException e) {
            return s;
        }
    }

    /** True for character/unknown types where the text itself is the value. */
    public static boolean isText(int sqlType) {
        return switch (sqlType) {
            case Types.CHAR, Types.VARCHAR, Types.LONGVARCHAR, Types.NCHAR, Types.NVARCHAR,
                 Types.LONGNVARCHAR, Types.CLOB, Types.NCLOB, Types.OTHER -> true;
            default -> false;
        };
    }

    /** True for numeric JDBC types. */
    public static boolean isNumeric(int sqlType) {
        return switch (sqlType) {
            case Types.TINYINT, Types.SMALLINT, Types.INTEGER, Types.BIGINT, Types.DECIMAL,
                 Types.NUMERIC, Types.REAL, Types.FLOAT, Types.DOUBLE -> true;
            default -> false;
        };
    }

    /**
     * Bind values to a prepared statement, coercing text to the parameter types the driver
     * reports (Postgres infers them from the statement). Drivers that cannot describe parameters
     * (some Oracle setups) fall back to binding the values unchanged.
     */
    public static void bindAll(PreparedStatement ps, List<?> binds) throws SQLException {
        int[] types = new int[binds.size()];
        java.util.Arrays.fill(types, Types.OTHER);
        boolean anyText = binds.stream().anyMatch(b -> b instanceof String);
        if (anyText) {
            try {
                ParameterMetaData pm = ps.getParameterMetaData();
                int n = Math.min(pm.getParameterCount(), binds.size());
                for (int i = 0; i < n; i++) types[i] = pm.getParameterType(i + 1);
            } catch (SQLException | RuntimeException ignored) {
                // parameter metadata not supported: bind as given
            }
        }
        for (int i = 0; i < binds.size(); i++) {
            ps.setObject(i + 1, coerce(binds.get(i), types[i]));
        }
    }

    private static String stripNumber(String t) {
        return t.replace(",", "").replace("_", "");
    }

    private static Object bool(String t, String original) {
        return switch (t.toLowerCase(Locale.ROOT)) {
            case "true", "t", "1", "yes", "y", "on" -> Boolean.TRUE;
            case "false", "f", "0", "no", "n", "off" -> Boolean.FALSE;
            default -> original;
        };
    }

    private static Object date(String t) {
        if (t.length() > 10 && (t.charAt(10) == 'T' || t.charAt(10) == ' ')) t = t.substring(0, 10);
        return java.sql.Date.valueOf(LocalDate.parse(t));
    }

    private static Object timestamp(String t) {
        String x = t.replace(' ', 'T');
        if (x.length() == 10) return java.sql.Timestamp.valueOf(LocalDate.parse(x).atStartOfDay());
        if (x.endsWith("Z") || x.matches(".*[+-]\\d{2}:?\\d{2}$")) {
            return java.sql.Timestamp.from(OffsetDateTime.parse(x).toInstant());
        }
        return java.sql.Timestamp.valueOf(LocalDateTime.parse(x));
    }
}
