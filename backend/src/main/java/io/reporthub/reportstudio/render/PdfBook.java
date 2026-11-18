package io.reporthub.reportstudio.render;

import com.lowagie.text.Chunk;
import com.lowagie.text.Document;
import com.lowagie.text.Element;
import com.lowagie.text.Font;
import com.lowagie.text.PageSize;
import com.lowagie.text.Paragraph;
import com.lowagie.text.Rectangle;
import com.lowagie.text.pdf.BaseFont;
import com.lowagie.text.pdf.PdfPCell;
import com.lowagie.text.pdf.PdfPTable;
import com.lowagie.text.pdf.PdfReader;
import com.lowagie.text.pdf.PdfSmartCopy;
import com.lowagie.text.pdf.PdfWriter;
import com.lowagie.text.pdf.draw.DottedLineSeparator;

import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;

/**
 * Concatenates several PDFs into a single "book" with a table of contents computed from real page numbers.
 *
 * <p>Used by {@code BookEngine}, which renders an existing report once per branch and joins them. This layer
 * is needed because each per-branch report carries its own cover and TOC; joined raw, a cover would appear
 * every couple of pages. So the leading pages are dropped from every part and one book TOC is built.
 *
 * <p>Gotcha: TOC page numbers depend on the TOC's own length (a longer TOC shifts the content), so it is
 * rebuilt until the page count stabilises - see {@link #buildToc}
 *
 * <p>OpenPDF already ships with JasperReports; no extra dependency (same as {@link PdfWatermark})
 */
public final class PdfBook {

    /** One TOC line; empty {@code group} = no group heading */
    public record Entry(String group, String label, int page) { }

    private PdfBook() { }

    /** Page count of one PDF file */
    public static int pageCount(Path pdf) throws Exception {
        PdfReader r = new PdfReader(pdf.toString());
        try {
            return r.getNumberOfPages();
        } finally {
            r.close();
        }
    }

    /**
     * Join all files into one book, dropping the first {@code dropLeading} pages from every content part
     *
     * @param toc   TOC file placed first; null = no TOC (TOC is never trimmed)
     * @param parts content files in book order
     */
    public static Path merge(Path toc, List<Path> parts, int dropLeading, Path target) throws Exception {
        return merge(null, toc, parts, dropLeading, target);
    }

    /**
     * Assemble a book with a book cover placed before the table of contents.
     *
     * @param cover cover file placed first; null = no cover (leading pages are not dropped from it)
     */
    public static Path merge(Path cover, Path toc, List<Path> parts, int dropLeading, Path target)
            throws Exception {
        Document doc = new Document(PageSize.A4);
        try (OutputStream out = Files.newOutputStream(target)) {
            // PdfSmartCopy deduplicates objects (fonts/images shared by all parts) - a 400+ part book gets much smaller
            PdfSmartCopy copy = new PdfSmartCopy(doc, out);
            doc.open();
            if (cover != null) appendAll(copy, cover, 0);
            if (toc != null) appendAll(copy, toc, 0);
            for (Path p : parts) appendAll(copy, p, dropLeading);
            doc.close();
        }
        return target;
    }

    /**
     * Copy pages {@code 1..count} of {@code src} into a new file; used to build the book cover
     * from the first child's cover.
     *
     * <p>Returns null when the source has fewer pages than requested (better to produce the book
     * without a cover than to fail the whole job).
     */
    public static Path extractLeading(Path src, int count, Path target) throws Exception {
        if (src == null || count <= 0) return null;
        PdfReader r = new PdfReader(src.toString());
        try {
            if (r.getNumberOfPages() < count) return null;
            Document doc = new Document(PageSize.A4);
            try (OutputStream out = Files.newOutputStream(target)) {
                PdfSmartCopy copy = new PdfSmartCopy(doc, out);
                doc.open();
                for (int i = 1; i <= count; i++) copy.addPage(copy.getImportedPage(r, i));
                doc.close();
            }
        } finally {
            r.close();
        }
        return target;
    }

    private static void appendAll(PdfSmartCopy copy, Path pdf, int dropLeading) throws Exception {
        PdfReader r = new PdfReader(pdf.toString());
        try {
            int n = r.getNumberOfPages();
            // Gotcha: a part with only leading pages (a branch with no data yields just cover + TOC) must be **skipped entirely**.
            //    Never clamp the range to keep one page, or a child's cover silently ends up in the book.
            //    (BookEngine already filters these out; this is a second guard.)
            int drop = Math.max(0, dropLeading);
            if (n <= drop) {
                copy.freeReader(r);
                return;
            }
            for (int i = drop + 1; i <= n; i++) {
                copy.addPage(copy.getImportedPage(r, i));
            }
            copy.freeReader(r);
        } finally {
            r.close();
        }
    }

    /**
     * Build the book TOC and return a file whose page count has "stabilised"
     *
     * <p>{@code entries} carry page numbers counted within the content only (first content page = 1). This method
     * adds the TOC page count itself and rebuilds until the page count no longer changes (at most 5 rounds).
     */
    public static Path buildToc(String title, List<Entry> entries, Path target) throws Exception {
        return buildToc(title, entries, target, 0);
    }

    /**
     * @param lead number of pages before the TOC (the book cover); TOC page numbers include it
     */
    public static Path buildToc(String title, List<Entry> entries, Path target, int lead)
            throws Exception {
        int tocPages = 1;
        byte[] pdf = null;
        for (int pass = 0; pass < 5; pass++) {
            pdf = renderToc(title, entries, lead + tocPages);
            int pages = pagesOf(pdf);
            if (pages == tocPages) break;
            tocPages = pages;
        }
        Files.write(target, Objects.requireNonNull(pdf));
        return target;
    }

    private static int pagesOf(byte[] pdf) throws Exception {
        PdfReader r = new PdfReader(pdf);
        try {
            return r.getNumberOfPages();
        } finally {
            r.close();
        }
    }

    private static byte[] renderToc(String title, List<Entry> entries, int offset) throws Exception {
        BaseFont bfR = UnicodeFonts.baseFont(false);
        BaseFont bfB = UnicodeFonts.baseFont(true);
        Font fTitle = new Font(bfB, 20);
        Font fGroup = new Font(bfB, 15);
        Font fItem = new Font(bfR, 15);

        Document doc = new Document(PageSize.A4, 64, 56, 56, 56);
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        PdfWriter.getInstance(doc, out);
        doc.open();

        if (title != null && !title.isBlank()) {
            Paragraph h = new Paragraph(title, fTitle);
            h.setAlignment(Element.ALIGN_CENTER);
            h.setSpacingAfter(18f);
            doc.add(h);
        }

        PdfPTable t = new PdfPTable(new float[]{ 88f, 12f });
        t.setWidthPercentage(100f);
        t.getDefaultCell().setBorder(Rectangle.NO_BORDER);

        String lastGroup = null;
        for (Entry e : entries) {
            String g = e.group() == null ? "" : e.group().trim();
            if (!g.isEmpty() && !g.equals(lastGroup)) {
                PdfPCell gc = new PdfPCell(new Paragraph(g, fGroup));
                gc.setColspan(2);
                gc.setBorder(Rectangle.NO_BORDER);
                gc.setPaddingTop(10f);
                gc.setPaddingBottom(2f);
                t.addCell(gc);
                lastGroup = g;
            }
            // Label + dot leader to the end of the cell
            Paragraph label = new Paragraph(e.label() == null ? "" : e.label(), fItem);
            label.add(new Chunk(new DottedLineSeparator()));
            PdfPCell lc = new PdfPCell(label);
            lc.setBorder(Rectangle.NO_BORDER);
            lc.setPaddingBottom(3f);
            t.addCell(lc);

            PdfPCell pc = new PdfPCell(new Paragraph(String.valueOf(e.page() + offset), fItem));
            pc.setBorder(Rectangle.NO_BORDER);
            pc.setHorizontalAlignment(Element.ALIGN_RIGHT);
            pc.setPaddingBottom(3f);
            t.addCell(pc);
        }
        if (entries.isEmpty()) {
            PdfPCell empty = new PdfPCell(new Paragraph(" ", fItem));
            empty.setColspan(2);
            empty.setBorder(Rectangle.NO_BORDER);
            t.addCell(empty);
        }
        doc.add(t);
        doc.close();
        return out.toByteArray();
    }

    /** Clean up temp files without throwing */
    public static void deleteQuietly(Path p) {
        if (p == null) return;
        try {
            Files.deleteIfExists(p);
        } catch (Exception ignore) {
            // Leave it to the OS - better than failing a job that already succeeded
        }
    }

    /** Delete a job's whole temp folder (recursively) */
    public static void deleteDirQuietly(Path dir) {
        if (dir == null) return;
        try (var s = Files.walk(dir)) {
            // Delete deepest first, otherwise a non-empty parent cannot be removed
            s.sorted(java.util.Comparator.reverseOrder()).forEach(PdfBook::deleteQuietly);
        } catch (Exception ignore) {
            // Skip if it cannot be walked - leave it to the OS rather than failing a successful job
            deleteQuietly(dir);
        }
    }
}
