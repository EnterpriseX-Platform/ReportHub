package io.reporthub.reportstudio.integration;

import java.time.LocalDate;

/** Folder path template for FileHub delivery: {code}, {yyyy}, {mm}, {dd}. */
public final class DeliveryPath {

    private DeliveryPath() {}

    /**
     * Render {@code template}; blank = "" (no folder). The code is restricted to safe characters and
     * slashes are normalised (no leading/trailing/double slashes, no "." / ".." segments).
     */
    public static String render(String template, String reportCode, LocalDate date) {
        if (template == null || template.isBlank()) return "";
        String code = reportCode == null ? "" : reportCode.replaceAll("[^\\p{L}\\p{N}._-]", "_");
        String s = template.trim()
                .replace("{code}", code)
                .replace("{yyyy}", String.format("%04d", date.getYear()))
                .replace("{mm}", String.format("%02d", date.getMonthValue()))
                .replace("{dd}", String.format("%02d", date.getDayOfMonth()));
        StringBuilder out = new StringBuilder();
        for (String seg : s.split("/")) {
            String t = seg.trim();
            if (t.isEmpty() || t.equals(".") || t.equals("..")) continue;
            if (out.length() > 0) out.append('/');
            out.append(t);
        }
        return out.length() > 200 ? out.substring(0, 200) : out.toString();
    }
}
