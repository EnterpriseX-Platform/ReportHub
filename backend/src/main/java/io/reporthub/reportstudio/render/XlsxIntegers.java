package io.reporthub.reportstudio.render;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * POI writes every numeric cell as a double ({@code <v>250.0</v>}), so readers that type cells by
 * their text (pandas/openpyxl, CSV conversion) see 250.0 for an integer. This rewrites the sheet XML
 * so whole numbers are stored as {@code <v>250</v>} - streaming, one pass, no workbook in memory.
 */
public final class XlsxIntegers {

    private XlsxIntegers() {}

    public static byte[] fix(byte[] xlsx) {
        if (xlsx == null || xlsx.length == 0) return xlsx;
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream(xlsx.length);
            rewrite(new ByteArrayInputStream(xlsx), out);
            return out.toByteArray();
        } catch (Exception e) {
            return xlsx;   // never lose an export over cosmetics
        }
    }

    /** Rewrite {@code file} in place (via a sibling temp file). Leaves the file unchanged on failure. */
    public static void fix(Path file) {
        Path tmp = null;
        try {
            tmp = Files.createTempFile(file.getParent(), "xi-", ".xlsx");
            try (InputStream in = Files.newInputStream(file); OutputStream out = Files.newOutputStream(tmp)) {
                rewrite(in, out);
            }
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
            tmp = null;
        } catch (Exception ignored) {
            // keep the original
        } finally {
            if (tmp != null) try { Files.deleteIfExists(tmp); } catch (IOException ignored) { }
        }
    }

    public static void rewrite(InputStream xlsx, OutputStream target) throws IOException {
        // commons-compress: POI writes entries with data descriptors that java.util.zip refuses to read.
        var zin = new org.apache.commons.compress.archivers.zip.ZipArchiveInputStream(xlsx, "UTF-8", true, true);
        ZipOutputStream zout = new ZipOutputStream(target);
        org.apache.commons.compress.archivers.zip.ZipArchiveEntry e;
        byte[] buf = new byte[64 * 1024];
        while ((e = zin.getNextZipEntry()) != null) {
            zout.putNextEntry(new ZipEntry(e.getName()));
            if (e.getName().startsWith("xl/worksheets/") && e.getName().endsWith(".xml")) {
                filter(zin, zout);
            } else {
                int n;
                while ((n = zin.read(buf)) > 0) zout.write(buf, 0, n);
            }
            zout.closeEntry();
        }
        zout.finish();
    }

    private static final byte[] OPEN = "<v>".getBytes();

    /** Copy, turning {@code <v>-?digits.0</v>} into {@code <v>-?digits</v>}. */
    static void filter(InputStream in, OutputStream out) throws IOException {
        java.io.BufferedInputStream bin = new java.io.BufferedInputStream(in, 64 * 1024);
        java.io.BufferedOutputStream bout = new java.io.BufferedOutputStream(out, 64 * 1024);
        int matched = 0;
        int b;
        while ((b = bin.read()) != -1) {
            bout.write(b);
            if (b == OPEN[matched]) {
                matched++;
                if (matched == OPEN.length) {
                    matched = 0;
                    // read the value up to '<' (bounded), then decide
                    StringBuilder v = new StringBuilder();
                    int c;
                    while ((c = bin.read()) != -1 && c != '<' && v.length() < 64) v.append((char) c);
                    String s = v.toString();
                    if (c == '<' && s.matches("-?\\d{1,15}\\.0")) s = s.substring(0, s.length() - 2);
                    for (int i = 0; i < s.length(); i++) bout.write(s.charAt(i));
                    if (c != -1) bout.write(c);
                }
            } else {
                matched = b == OPEN[0] ? 1 : 0;
            }
        }
        bout.flush();
    }
}
