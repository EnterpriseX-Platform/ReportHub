package io.reporthub.reportstudio.analytics;

import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.IndexedColors;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.List;
import java.util.Map;

/**
 * Renders pivot / ad-hoc results to a real .xlsx workbook (Apache POI).
 * Numbers use a thousands-separated number format; header and total rows are bold.
 */
@Component
public class XlsxExporter {

    /** Pivot grid: row label column + one column per colKey + Total, then a Total row. */
    public byte[] pivot(PivotResponse pivot) {
        try (Workbook wb = new XSSFWorkbook()) {
            Sheet sheet = wb.createSheet("Pivot");
            CellStyle header = headerStyle(wb);
            CellStyle number = numberStyle(wb);
            CellStyle boldNumber = boldNumberStyle(wb);
            CellStyle boldText = boldTextStyle(wb);

            List<String> colKeys = pivot.colKeys();

            int r = 0;
            Row head = sheet.createRow(r++);
            text(head, 0, "Item", header);
            for (int c = 0; c < colKeys.size(); c++) {
                text(head, c + 1, colKeys.get(c), header);
            }
            text(head, colKeys.size() + 1, "Total", header);

            for (PivotResponse.Row row : pivot.rows()) {
                Row xr = sheet.createRow(r++);
                String indent = "    ".repeat(Math.max(0, row.depth()));
                text(xr, 0, indent + row.label(), row.isGroup() ? boldText : null);
                CellStyle numStyle = row.isGroup() ? boldNumber : number;
                for (int c = 0; c < colKeys.size(); c++) {
                    number(xr, c + 1, row.vals().getOrDefault(colKeys.get(c), 0L), numStyle);
                }
                number(xr, colKeys.size() + 1, row.rowTotal(), numStyle);
            }

            Row totalRow = sheet.createRow(r);
            text(totalRow, 0, "Grand total", boldText);
            for (int c = 0; c < colKeys.size(); c++) {
                number(totalRow, c + 1, pivot.colTotals().getOrDefault(colKeys.get(c), 0L), boldNumber);
            }
            number(totalRow, colKeys.size() + 1, pivot.grand(), boldNumber);

            autosize(sheet, colKeys.size() + 2);
            return bytes(wb);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Ad-hoc result: one column per requested field + a totals row for measures. */
    public byte[] adhoc(AdhocResult result) {
        try (Workbook wb = new XSSFWorkbook()) {
            Sheet sheet = wb.createSheet("Adhoc");
            CellStyle header = headerStyle(wb);
            CellStyle number = numberStyle(wb);
            CellStyle boldNumber = boldNumberStyle(wb);
            CellStyle boldText = boldTextStyle(wb);

            List<String> columns = result.columns();

            int r = 0;
            Row head = sheet.createRow(r++);
            for (int c = 0; c < columns.size(); c++) {
                text(head, c, columns.get(c), header);
            }

            for (Map<String, Object> row : result.rows()) {
                Row xr = sheet.createRow(r++);
                for (int c = 0; c < columns.size(); c++) {
                    Object v = row.get(columns.get(c));
                    if (v instanceof Number n) {
                        number(xr, c, n.longValue(), number);
                    } else {
                        text(xr, c, v == null ? "" : v.toString(), null);
                    }
                }
            }

            // Totals row across measure columns.
            if (!result.totals().isEmpty()) {
                Row totalRow = sheet.createRow(r);
                boolean labelPlaced = false;
                for (int c = 0; c < columns.size(); c++) {
                    String col = columns.get(c);
                    Long total = result.totals().get(col);
                    if (total != null) {
                        number(totalRow, c, total, boldNumber);
                    } else if (!labelPlaced) {
                        text(totalRow, c, "Total", boldText);
                        labelPlaced = true;
                    }
                }
                if (!labelPlaced) {
                    // No leading dimension column — drop the label into a trailing cell.
                    text(totalRow, columns.size(), "Total", boldText);
                }
            }

            autosize(sheet, columns.size() + 1);
            return bytes(wb);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static void text(Row row, int col, String value, CellStyle style) {
        Cell cell = row.createCell(col);
        cell.setCellValue(value);
        if (style != null) cell.setCellStyle(style);
    }

    private static void number(Row row, int col, long value, CellStyle style) {
        Cell cell = row.createCell(col);
        cell.setCellValue((double) value);
        if (style != null) cell.setCellStyle(style);
    }

    private static CellStyle headerStyle(Workbook wb) {
        CellStyle s = wb.createCellStyle();
        Font f = wb.createFont();
        f.setBold(true);
        f.setColor(IndexedColors.WHITE.getIndex());
        s.setFont(f);
        s.setFillForegroundColor(IndexedColors.DARK_BLUE.getIndex());
        s.setFillPattern(FillPatternType.SOLID_FOREGROUND);
        return s;
    }

    private static CellStyle numberStyle(Workbook wb) {
        CellStyle s = wb.createCellStyle();
        s.setDataFormat(wb.createDataFormat().getFormat("#,##0"));
        return s;
    }

    private static CellStyle boldNumberStyle(Workbook wb) {
        CellStyle s = wb.createCellStyle();
        Font f = wb.createFont();
        f.setBold(true);
        s.setFont(f);
        s.setDataFormat(wb.createDataFormat().getFormat("#,##0"));
        return s;
    }

    private static CellStyle boldTextStyle(Workbook wb) {
        CellStyle s = wb.createCellStyle();
        Font f = wb.createFont();
        f.setBold(true);
        s.setFont(f);
        return s;
    }

    private static void autosize(Sheet sheet, int cols) {
        for (int c = 0; c < cols; c++) {
            sheet.autoSizeColumn(c);
        }
    }

    private static byte[] bytes(Workbook wb) throws IOException {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            wb.write(out);
            return out.toByteArray();
        }
    }
}
