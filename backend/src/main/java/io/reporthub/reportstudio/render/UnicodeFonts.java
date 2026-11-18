package io.reporthub.reportstudio.render;

import com.lowagie.text.pdf.BaseFont;

import java.io.File;
import java.io.InputStream;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Unicode-capable fonts for the built-in PDF layouts (generic table, book TOC, watermark).
 *
 * <p>The PDF standard fonts (Helvetica) only cover WinAnsi, so Thai or any other non-Latin text
 * renders as blanks. These helpers embed a bundled TrueType font (resources/fonts) with Identity-H
 * encoding, which covers Thai + Latin + digits.
 */
public final class UnicodeFonts {

    /** Jasper font-extension family (fonts/fonts.xml) used by the programmatic layouts. */
    public static final String JASPER_FAMILY = "TH Sarabun New";

    private static final String[] SYSTEM_DIRS = {
            System.getProperty("app.book.font-dir", "/usr/share/fonts/truetype/thai"),
            "/usr/share/fonts/truetype/thai",
    };
    private static final String[] REGULAR = {
            "/fonts/THSarabunNew/THSarabunNew.ttf", "/fonts/TH SarabunPSK.ttf" };
    private static final String[] BOLD = {
            "/fonts/THSarabunNew/THSarabunNew Bold.ttf", "/fonts/TH SarabunPSK Bold.ttf" };

    private static final ConcurrentHashMap<Boolean, byte[]> CACHE = new ConcurrentHashMap<>();

    private UnicodeFonts() { }

    /** Embedded Identity-H font; falls back to Helvetica only if no bundled font is readable. */
    public static BaseFont baseFont(boolean bold) throws Exception {
        String[] names = bold ? BOLD : REGULAR;
        byte[] ttf = CACHE.computeIfAbsent(bold, b -> load(names));
        if (ttf != null) {
            String n = names[0].substring(names[0].lastIndexOf('/') + 1);
            return BaseFont.createFont(n, BaseFont.IDENTITY_H, BaseFont.EMBEDDED, true, ttf, null);
        }
        return BaseFont.createFont(bold ? BaseFont.HELVETICA_BOLD : BaseFont.HELVETICA,
                BaseFont.WINANSI, BaseFont.NOT_EMBEDDED);
    }

    private static byte[] load(String[] names) {
        for (String res : names) {
            try (InputStream in = UnicodeFonts.class.getResourceAsStream(res)) {
                if (in != null) return in.readAllBytes();
            } catch (Exception ignore) {
                // try the next one
            }
        }
        for (String dir : SYSTEM_DIRS) {
            for (String res : names) {
                File f = new File(dir, res.substring(res.lastIndexOf('/') + 1));
                try {
                    if (f.isFile()) return java.nio.file.Files.readAllBytes(f.toPath());
                } catch (Exception ignore) {
                    // try the next one
                }
            }
        }
        return null;
    }
}
