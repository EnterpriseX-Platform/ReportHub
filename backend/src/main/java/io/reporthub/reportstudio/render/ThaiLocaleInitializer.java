package io.reporthub.reportstudio.render;

import net.sf.jasperreports.engine.DefaultJasperReportsContext;
import net.sf.jasperreports.export.PdfReportConfiguration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Locale;

/**
 * Makes JasperReports wrap Thai text at word boundaries instead of mid-word — for BOTH the layout
 * measurement AND the PDF output. Two independent pieces are required; either one alone leaves the
 * PDF broken (this was the long-standing "th default is set yet PDF still splits mid-word" paradox).
 *
 * <p><b>1. JVM default locale = Thai.</b> Thai has no inter-word spaces. The fill-time text measurer
 * and the AWT/Graphics2D/XLSX text layout find line-break opportunities with the JVM's
 * <em>default-locale</em> {@link java.text.BreakIterator} — NOT the report locale
 * ({@code REPORT_LOCALE} has no effect), and not a zero-width space (U+200B, which the JDK break
 * iterator ignores). Only a Thai default engages the JDK's Thai line dictionary that segments the run
 * into words. The break dictionary is language-level, so {@code new Locale("th")} is enough — and
 * unlike {@code th_TH} it keeps the Gregorian calendar, so date formatting does not silently switch
 * to the Buddhist era. {@link Locale#setDefault} is JVM-global and renders run on a concurrent worker
 * pool, so it is applied ONCE at startup (before any render), where a per-fill set/restore would race.
 *
 * <p><b>2. Thai routed through the PDF glyph renderer.</b> The locale fix alone does NOT reach PDF
 * output: {@code JRPdfExporter}'s <em>default</em> text renderer wraps by width with no dictionary
 * and ignores the locale entirely, so it still splits Thai words mid-syllable (e.g. a vowel sign
 * U+0E30 split off from its syllable). JasperReports only applies its complex-script, locale-aware glyph renderer
 * to the Unicode blocks listed in {@code net.sf.jasperreports.export.pdf.glyph.renderer.blocks.*}
 * (default: devanagari, khmer, myanmar, … — Thai is NOT included). Registering the Thai block routes
 * Thai text through that glyph renderer, which lays out with an AWT {@code LineBreakMeasurer} (so it
 * honours the Thai default locale from piece 1) — giving correct word-wrapping in the PDF with no
 * change to glyph shaping. Verified end-to-end against the real report + JDBC data: mid-word breaks
 * disappear only when both pieces are in place.
 *
 * <p>On by default; set {@code app.report.thai-locale=false} (env {@code APP_REPORT_THAI_LOCALE=false})
 * to leave the platform default locale untouched and skip the glyph-renderer registration.
 */
@Component
public class ThaiLocaleInitializer {

    private static final Logger log = LoggerFactory.getLogger(ThaiLocaleInitializer.class);

    /** JasperReports Unicode-block name for the Thai script (matches {@code Character.UnicodeBlock.THAI}). */
    private static final String THAI_BLOCK = "thai";

    public ThaiLocaleInitializer(@Value("${app.report.thai-locale:true}") boolean enabled) {
        if (!enabled) {
            log.info("Thai line-break locale disabled (app.report.thai-locale=false); JVM default locale left as {}",
                    Locale.getDefault());
            return;
        }
        Locale prev = Locale.getDefault();
        Locale.setDefault(new Locale("th"));

        // Route Thai through JRPdfExporter's locale-aware glyph renderer; without this the PDF still
        // splits Thai words mid-syllable even with a Thai default locale (the fill/XLSX path already
        // wraps correctly). Property key: net.sf.jasperreports.export.pdf.glyph.renderer.blocks.thai
        DefaultJasperReportsContext.getInstance().setProperty(
                PdfReportConfiguration.PROPERTY_PREFIX_GLYPH_RENDERER_BLOCKS + THAI_BLOCK, THAI_BLOCK);

        log.info("Thai line-break enabled: JVM default locale {} -> {} and Thai registered for the PDF glyph renderer",
                prev, Locale.getDefault());
    }
}
