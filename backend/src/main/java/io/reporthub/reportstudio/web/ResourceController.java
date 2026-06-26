package io.reporthub.reportstudio.web;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.http.HttpStatus;
import io.reporthub.reportstudio.service.ResourceService;
import io.reporthub.reportstudio.storage.ObjectStorageService;
import io.reporthub.reportstudio.storage.StoredObjectMeta;

import javax.imageio.ImageIO;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.List;
import java.util.Set;

/**
 * Global, reusable report resources (logos / images / fonts). Uploaded once in Settings and shared
 * by every report: at render time the renderer copies them into SUBREPORT_DIR, so any template that
 * references e.g. {@code $P{SUBREPORT_DIR}+"BB_logo.png"} resolves without a per-report upload. A
 * per-report unit resource with the same filename overrides the shared one.
 *
 * <p>Stored under the {@code shared/} prefix of the report-outputs bucket. Files travel as base64 in
 * a JSON body (same reason as the unit upload: the UAT Cloudflare WAF rejects some multipart bodies).</p>
 */
@RestController
@RequestMapping("/resources")
public class ResourceController {

    /** MinIO key prefix for shared resources. Must match ReportRenderer.SHARED_RESOURCE_PREFIX. */
    public static final String PREFIX = "shared/";

    private static final Set<String> ALLOWED_EXT = Set.of("png", "jpg", "jpeg", "gif", "ttf", "otf");
    private static final Set<String> IMAGE_EXT = Set.of("png", "jpg", "jpeg", "gif");
    private static final long MAX_BYTES = 25L * 1024 * 1024;
    private static final int THUMB_MAX = 72;
    /** Only thumbnail small source images (logos), at most this many per list — bounds list() latency/memory. */
    private static final long THUMB_SRC_MAX = 2L * 1024 * 1024;
    private static final int THUMB_MAX_COUNT = 60;
    /** Reject decoding an image whose declared pixel count exceeds this (decompression-bomb guard). */
    private static final long THUMB_MAX_PIXELS = 8_000_000L;

    private final ObjectStorageService storage;
    private final ResourceService resources;

    public ResourceController(ObjectStorageService storage, ResourceService resources) {
        this.storage = storage;
        this.resources = resources;
    }

    public record ResourceDto(String name, long sizeBytes, String contentType, String thumbnail) {}
    public record ResourceUpload(String fileName, String contentBase64, String encoding) {}

    @GetMapping
    public List<ResourceDto> list() {
        List<StoredObjectMeta> metas = storage.list(PREFIX).stream()
                .filter(m -> !stripPrefix(m.objectKey()).isBlank())
                .sorted((a, b) -> stripPrefix(a.objectKey()).compareToIgnoreCase(stripPrefix(b.objectKey())))
                .toList();
        List<ResourceDto> out = new java.util.ArrayList<>(metas.size());
        int thumbs = 0;
        for (StoredObjectMeta m : metas) {
            ResourceDto dto = toDto(m, thumbs < THUMB_MAX_COUNT);
            if (dto.thumbnail() != null) thumbs++;
            out.add(dto);
        }
        return out;
    }

    /** Which reports reference a shared resource (for a delete confirmation in the UI). */
    @GetMapping("/{name}/usage")
    public List<String> usage(@PathVariable String name) {
        return resources.findUsages(sanitize(name));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ResourceDto upload(@RequestBody ResourceUpload body) {
        if (body == null || body.fileName() == null || body.fileName().isBlank()) {
            throw new BadRequestException("fileName is required");
        }
        if (body.contentBase64() == null || body.contentBase64().isBlank()) {
            throw new BadRequestException("File is empty");
        }
        String name = sanitize(body.fileName());
        String ext = ext(name);
        if (!ALLOWED_EXT.contains(ext)) {
            throw new BadRequestException("File type ." + ext + " not allowed (logo/image/font only)");
        }
        byte[] bytes = UnitController.decodeUploadContent(body.contentBase64(), body.encoding());
        if (bytes.length > MAX_BYTES) {
            throw new BadRequestException("File exceeds 25 MB");
        }
        StoredObjectMeta meta = storage.put(PREFIX + name, bytes, contentType(ext));
        return new ResourceDto(name, meta.sizeBytes(), contentType(ext), thumbnail(bytes));
    }

    @DeleteMapping("/{name}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String name, @RequestParam(defaultValue = "false") boolean force) {
        String n = sanitize(name);
        if (!force) {
            List<String> used = resources.findUsages(n);
            if (!used.isEmpty()) {
                throw new BadRequestException("Resource '" + n + "' is used by " + used.size()
                        + " report(s): " + String.join(", ", used)
                        + ". Delete anyway with force=true.");
            }
        }
        storage.delete(PREFIX + n);
    }

    private ResourceDto toDto(StoredObjectMeta m, boolean allowThumb) {
        String name = stripPrefix(m.objectKey());
        String ext = ext(name);
        String thumb = null;
        // Only fetch+decode small image sources, and only when under the per-list count cap.
        if (allowThumb && IMAGE_EXT.contains(ext) && m.sizeBytes() > 0 && m.sizeBytes() <= THUMB_SRC_MAX) {
            try {
                thumb = thumbnail(storage.get(m.objectKey()));
            } catch (Throwable ignore) {
                // a broken/oversized/unreadable image just renders without a preview
            }
        }
        return new ResourceDto(name, m.sizeBytes(), contentType(ext), thumb);
    }

    /**
     * Downscale an image to a small PNG data-URI for the Settings list. Reads the header dimensions
     * first and refuses to decode an image larger than {@link #THUMB_MAX_PIXELS} (decompression-bomb
     * guard), so a tiny crafted file can't allocate gigabytes. Returns null on any failure.
     */
    private static String thumbnail(byte[] bytes) {
        if (bytes == null || bytes.length == 0) return null;
        try (javax.imageio.stream.ImageInputStream iis =
                     ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            if (iis == null) return null;
            java.util.Iterator<javax.imageio.ImageReader> readers = ImageIO.getImageReaders(iis);
            if (!readers.hasNext()) return null;
            javax.imageio.ImageReader reader = readers.next();
            try {
                reader.setInput(iis, true, true);
                long pixels = (long) reader.getWidth(0) * reader.getHeight(0);
                if (pixels <= 0 || pixels > THUMB_MAX_PIXELS) return null; // refuse to allocate a bomb
                BufferedImage src = reader.read(0);
                if (src == null) return null;
                int w = src.getWidth(), h = src.getHeight();
                double scale = Math.min(1.0, (double) THUMB_MAX / Math.max(w, h));
                int nw = Math.max(1, (int) Math.round(w * scale));
                int nh = Math.max(1, (int) Math.round(h * scale));
                BufferedImage thumb = new BufferedImage(nw, nh, BufferedImage.TYPE_INT_ARGB);
                Graphics2D g = thumb.createGraphics();
                g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                g.drawImage(src, 0, 0, nw, nh, null);
                g.dispose();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                ImageIO.write(thumb, "png", out);
                return "data:image/png;base64," + Base64.getEncoder().encodeToString(out.toByteArray());
            } finally {
                reader.dispose();
            }
        } catch (Throwable t) {
            return null;
        }
    }

    /** Keep only the bare filename — never let a path traversal escape the shared/ prefix. */
    private static String sanitize(String fileName) {
        String n = fileName.replace('\\', '/');
        if (n.contains("/")) n = n.substring(n.lastIndexOf('/') + 1);
        n = n.replaceAll("[^\\p{L}\\p{N}._-]", "_").trim();
        if (n.isBlank() || n.equals(".") || n.equals("..")) {
            throw new BadRequestException("Invalid file name");
        }
        return n;
    }

    private static String ext(String name) {
        return name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : "";
    }

    private static String stripPrefix(String key) {
        return key.startsWith(PREFIX) ? key.substring(PREFIX.length()) : key;
    }

    private static String contentType(String ext) {
        return switch (ext) {
            case "png" -> "image/png";
            case "jpg", "jpeg" -> "image/jpeg";
            case "gif" -> "image/gif";
            case "ttf" -> "font/ttf";
            case "otf" -> "font/otf";
            default -> "application/octet-stream";
        };
    }
}
