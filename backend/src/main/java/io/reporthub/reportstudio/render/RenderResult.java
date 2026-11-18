package io.reporthub.reportstudio.render;

/**
 * Result of a render: the rendered document plus metadata the web layer needs to
 * stream the file back (Content-Type, download extension, size).
 *
 * <p>Small artifacts are carried in {@link #bytes}. Large artifacts (e.g. a
 * query-export of millions of rows) are streamed to a temp file on disk instead, in
 * which case {@link #bytes} is {@code null} and {@link #filePath} points at the file —
 * the storage layer uploads it via a streaming put and the caller deletes it afterwards.</p>
 *
 * @param bytes       the rendered document, or {@code null} when file-backed
 * @param contentType MIME type, e.g. {@code application/pdf}
 * @param extension   file extension without the dot, e.g. {@code pdf}
 * @param sizeBytes   artifact length in bytes
 * @param filePath    temp file holding the artifact, or {@code null} when in-memory
 */
public record RenderResult(
        byte[] bytes,
        String contentType,
        String extension,
        long sizeBytes,
        java.nio.file.Path filePath
) {
    /** In-memory artifact (the common case). */
    public RenderResult(byte[] bytes, String contentType, String extension, long sizeBytes) {
        this(bytes, contentType, extension, sizeBytes, null);
    }

    /** File-backed artifact streamed to disk to keep large exports off the heap. */
    public static RenderResult ofFile(java.nio.file.Path file, String contentType, String extension, long sizeBytes) {
        return new RenderResult(null, contentType, extension, sizeBytes, file);
    }
}
