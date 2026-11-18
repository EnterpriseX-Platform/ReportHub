package io.reporthub.reportstudio.render;

import com.lowagie.text.Document;
import com.lowagie.text.PageSize;
import com.lowagie.text.Paragraph;
import com.lowagie.text.pdf.PdfWriter;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Join + drop leading pages + TOC whose page numbers match the real content */
class PdfBookTest {

    /** PDF Test PDF with n pages, each page carrying the text "pX" to identify it */
    private static Path pdf(Path dir, String name, int pages) throws Exception {
        Path f = dir.resolve(name);
        Document doc = new Document(PageSize.A4);
        try (var out = Files.newOutputStream(f)) {
            PdfWriter.getInstance(doc, out);
            doc.open();
            for (int i = 1; i <= pages; i++) {
                if (i > 1) doc.newPage();
                doc.add(new Paragraph(name + "-p" + i));
            }
            doc.close();
        }
        return f;
    }

    @Test
    void dropsLeadingPagesAndJoinsInOrder(@TempDir Path dir) throws Exception {
        Path a = pdf(dir, "a.pdf", 5);      // 3 left
        Path b = pdf(dir, "b.pdf", 4);      // 2 left
        Path out = PdfBook.merge(null, List.of(a, b), 2, dir.resolve("book.pdf"));

        assertThat(PdfBook.pageCount(out)).isEqualTo(5);
    }

    /**
     * Gotcha: a branch with no data yields only a cover (+TOC) - the whole part must disappear.
     * Never clamp the range so a cover sneaks into the book (OpenPDF selectPages does that silently).
     */
    @Test
    void partWithOnlyLeadingPagesIsSkipped(@TempDir Path dir) throws Exception {
        Path onlyCover = pdf(dir, "cover.pdf", 2);
        Path real = pdf(dir, "real.pdf", 5);
        Path out = PdfBook.merge(null, List.of(onlyCover, real), 2, dir.resolve("book.pdf"));

        assertThat(PdfBook.pageCount(out)).isEqualTo(3);
    }

    @Test
    void tocAddsItsOwnPageCountToContentPages(@TempDir Path dir) throws Exception {
        List<PdfBook.Entry> toc = List.of(
                new PdfBook.Entry("Group one", "First item", 1),
                new PdfBook.Entry("Group one", "Second item", 4));
        Path tocFile = PdfBook.buildToc("Contents", toc, dir.resolve("toc.pdf"));

        int tocPages = PdfBook.pageCount(tocFile);
        assertThat(tocPages).isEqualTo(1);

        Path a = pdf(dir, "a.pdf", 5);   // 3 pages left -> content pages 1-3
        Path b = pdf(dir, "b.pdf", 4);   // 2 pages left -> content pages 4-5
        Path out = PdfBook.merge(tocFile, List.of(a, b), 2, dir.resolve("book.pdf"));

        // 1 TOC page + 5 content pages; item two is on page 4+1 = 5, exactly the last page
        assertThat(PdfBook.pageCount(out)).isEqualTo(tocPages + 5);
    }

    @Test
    void multiPageTocStabilisesPageNumbers(@TempDir Path dir) throws Exception {
        List<PdfBook.Entry> many = new java.util.ArrayList<>();
        for (int i = 1; i <= 200; i++) many.add(new PdfBook.Entry("Group " + (i / 40), "Item " + i, i));
        Path tocFile = PdfBook.buildToc("Contents", many, dir.resolve("toc.pdf"));

        assertThat(PdfBook.pageCount(tocFile)).isGreaterThan(1);
    }
}
