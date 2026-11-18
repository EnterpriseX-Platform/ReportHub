package io.reporthub.reportstudio.render;

import com.lowagie.text.Element;
import com.lowagie.text.pdf.BaseFont;
import com.lowagie.text.pdf.PdfContentByte;
import com.lowagie.text.pdf.PdfGState;
import com.lowagie.text.pdf.PdfReader;
import com.lowagie.text.pdf.PdfStamper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.Color;
import java.io.ByteArrayOutputStream;

/**
 * PDF watermark - stamped after rendering, so no per-template changes are needed.
 *
 * <p>Reports must be downloadable with a watermark on every page, yet the same report must also be
 * available without one (e.g. draft vs approved), so it cannot be baked into the template - the
 * caller decides at run time.
 *
 * <p>Done at this layer because every PDF, whether from a user-uploaded Jasper template or an
 * engine built-in template, ends up as a byte[] at the same point, so all reports are covered without touching jrxml.
 *
 * <p>OpenPDF already ships with JasperReports; no extra dependency.
 */
public final class PdfWatermark {

    private static final Logger log = LoggerFactory.getLogger(PdfWatermark.class);

    /** Run-time parameter name sent by the caller - empty/absent = no watermark */
    public static final String PARAM = "WATERMARK_TEXT";

    private PdfWatermark() {}

    /**
     * Stamp a faint diagonal watermark in the centre of every page.
     *
     * <p>On failure the original file is returned and no exception is thrown - the watermark is an
     * extra and must not turn a successful render into a failed job (it is logged).
     *
     * @param pdf  rendered file
     * @param text watermark text; null/empty = return the original file immediately
     */
    public static byte[] stamp(byte[] pdf, String text) {
        if (pdf == null || pdf.length == 0 || text == null || text.isBlank()) return pdf;
        try {
            PdfReader reader = new PdfReader(pdf);
            ByteArrayOutputStream out = new ByteArrayOutputStream(pdf.length + 4096);
            PdfStamper stamper = new PdfStamper(reader, out);
            BaseFont font = UnicodeFonts.baseFont(true);
            int pages = reader.getNumberOfPages();
            for (int i = 1; i <= pages; i++) {
                com.lowagie.text.Rectangle box = reader.getPageSizeWithRotation(i);
                float w = box.getWidth(), h = box.getHeight();
                // Font size derived from page width so the watermark covers a similar area in portrait and landscape
                float size = Math.max(28f, Math.min(96f, (w * 1.5f) / Math.max(6, text.length())));
                PdfContentByte over = stamper.getOverContent(i);
                over.saveState();
                PdfGState gs = new PdfGState();
                gs.setFillOpacity(0.14f);          // faint: readable but does not hide the content
                over.setGState(gs);
                over.beginText();
                over.setFontAndSize(font, size);
                over.setColorFill(Color.GRAY);
                over.showTextAligned(Element.ALIGN_CENTER, text, w / 2f, h / 2f, 45);
                over.endText();
                over.restoreState();
            }
            stamper.close();
            reader.close();
            return out.toByteArray();
        } catch (Exception e) {
            log.warn("Watermark failed - returning the original file: {}", e.toString());
            return pdf;
        }
    }

    /** Read the watermark text from the run-time parameters */
    public static String textOf(java.util.Map<String, Object> params) {
        if (params == null) return null;
        Object v = params.get(PARAM);
        return v == null ? null : v.toString();
    }
}
