package io.reporthub.reportstudio.render;

import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;

/**
 * Excel "watermark": written as the print header of every sheet.
 *
 * <p>PDF output can overlay text in the middle of the page ({@link PdfWatermark}), but <b>an Excel
 * file has no page background layer to draw on</b>; it has no pages until printed, so a diagonal
 * PDF-style watermark is not possible.
 *
 * <p>The closest match is a <b>print header</b>: printed copies carry the label on every page,
 * while the on-screen file stays clean and usable, with no extra rows shifting the data.
 *
 * <p>POI header syntax: {@code &C} = center, {@code &"font name"}, {@code &10} = size,
 * {@code &K808080} = gray.
 */
public final class XlsxWatermark {

    private static final Logger log = LoggerFactory.getLogger(XlsxWatermark.class);

    private XlsxWatermark() {}

    /**
     * Put the label in the print header of every sheet.
     *
     * <p>On failure returns the original file instead of throwing, same as {@link PdfWatermark}.
     *
     * @param xlsx the exported file
     * @param text label text; null/blank = return the original file unchanged
     */
    /** Put the label into one sheet's print header while it is being written (streaming exports). */
    public static void header(Sheet sheet, String text) {
        if (sheet == null || text == null || text.isBlank()) return;
        sheet.getHeader().setCenter("&\"TH SarabunPSK\"&12&K808080" + text.replace("&", "&&"));
    }

    public static byte[] stamp(byte[] xlsx, String text) {
        if (xlsx == null || xlsx.length == 0 || text == null || text.isBlank()) return xlsx;
        try (Workbook wb = new XSSFWorkbook(new ByteArrayInputStream(xlsx));
             ByteArrayOutputStream out = new ByteArrayOutputStream(xlsx.length + 2048)) {
            // & is a header control character; it must be doubled to print a literal &
            String safe = text.replace("&", "&&");
            for (int i = 0; i < wb.getNumberOfSheets(); i++) {
                Sheet sh = wb.getSheetAt(i);
                sh.getHeader().setCenter("&\"TH SarabunPSK\"&12&K808080" + safe);
            }
            wb.write(out);
            return out.toByteArray();
        } catch (Exception e) {
            log.warn("Failed to stamp Excel header; returning the original file: {}", e.toString());
            return xlsx;
        }
    }
}
