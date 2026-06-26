package io.reporthub.reportstudio.web;

import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.domain.OutputFile;
import io.reporthub.reportstudio.repo.OutputFileRepository;
import io.reporthub.reportstudio.storage.ObjectStorageService;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * Generated report outputs persisted in object storage (MinIO).
 *
 * <ul>
 *   <li>{@code GET /outputs}                       — list output files, newest first</li>
 *   <li>{@code GET /outputs/{objectKey}/download}  — stream the stored bytes back</li>
 * </ul>
 *
 * <p>The store is a single shared bucket with no per-object ACL, so access is scoped
 * here in the controller. {@link io.reporthub.reportstudio.security.SecurityConfig} requires
 * every request to be authenticated ({@code anyRequest().authenticated()}); on top of that:
 * <ul>
 *   <li>report-run outputs (those carrying a {@code jobId}) are shared across the signed-in
 *       team — any authenticated user may list and download them;</li>
 *   <li>analytics / saved-view exports ({@code jobId} is null) are scoped to their creator,
 *       so a caller only sees and downloads their own;</li>
 *   <li>an {@code ADMIN} may list and download everything.</li>
 * </ul>
 */
@RestController
public class OutputController {

    /** {@code createdBy} markers that never belong to a real account and so are never caller-owned. */
    private static final String PUBLIC = "public";
    private static final String ANONYMOUS = "anonymous";

    private final OutputFileRepository outputs;
    private final ObjectStorageService storage;

    public OutputController(OutputFileRepository outputs, ObjectStorageService storage) {
        this.outputs = outputs;
        this.storage = storage;
    }

    /**
     * List output files visible to the caller, newest first: team-visible report-run outputs
     * plus the caller's own analytics exports. An {@code ADMIN} sees every output.
     */
    @GetMapping("/outputs")
    public List<OutputFileDto> list(Authentication auth) {
        List<OutputFile> rows = isAdmin(auth)
                ? outputs.findAllByOrderByCreatedAtDesc()
                : outputs.findVisibleTo(auth.getName());
        return rows.stream()
                .map(OutputController::toDto)
                .toList();
    }

    /** Slash-safe download (folder paths in the key). */
    @GetMapping("/outputs/download")
    public ResponseEntity<byte[]> downloadByKey(@org.springframework.web.bind.annotation.RequestParam("key") String key,
                                                Authentication auth) {
        return download(key, auth);
    }

    /** Stream a stored output back to the caller as a file download. */
    @GetMapping("/outputs/{objectKey}/download")
    public ResponseEntity<byte[]> download(@PathVariable String objectKey, Authentication auth) {
        OutputFile out = outputs.findByObjectKey(objectKey)
                .orElseThrow(() -> new NotFoundException("Output not found: " + objectKey));
        if (!canAccess(out, auth)) {
            // Deny as a 404, not a 403: a 403 would confirm the object exists and turn this
            // endpoint into an enumeration oracle for other users' analytics exports.
            throw new NotFoundException("Output not found: " + objectKey);
        }
        byte[] body = storage.get(out.getObjectKey());
        ContentDisposition cd = ContentDisposition.attachment().filename(out.getObjectKey()).build();
        return ResponseEntity.ok()
                .contentType(contentTypeFor(out.getFmt()))
                .header(HttpHeaders.CONTENT_DISPOSITION, cd.toString())
                .body(body);
    }

    /**
     * Whether {@code auth} may read {@code out}. Report-run outputs (a {@code jobId} is present)
     * are shared across the signed-in team; analytics / saved-view exports are visible only to
     * their creator. An {@code ADMIN} may read anything. Synthetic owners ({@code public} /
     * {@code anonymous}) are never matched to a real caller.
     */
    private static boolean canAccess(OutputFile out, Authentication auth) {
        if (isAdmin(auth)) {
            return true;
        }
        if (out.getJobId() != null) {
            return true; // team-visible report-run output
        }
        String owner = out.getCreatedBy();
        if (owner == null || PUBLIC.equals(owner) || ANONYMOUS.equals(owner)) {
            return false;
        }
        return auth != null && owner.equals(auth.getName());
    }

    private static boolean isAdmin(Authentication auth) {
        return auth != null && auth.getAuthorities().stream()
                .anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
    }

    private static MediaType contentTypeFor(String fmt) {
        if (fmt == null) return MediaType.APPLICATION_OCTET_STREAM;
        return switch (fmt.toUpperCase()) {
            case "PDF" -> MediaType.APPLICATION_PDF;
            case "XLSX" -> MediaType.parseMediaType(
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            case "CSV" -> MediaType.parseMediaType("text/csv");
            case "DOCX" -> MediaType.parseMediaType(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            default -> MediaType.APPLICATION_OCTET_STREAM;
        };
    }

    private static OutputFileDto toDto(OutputFile o) {
        return new OutputFileDto(
                o.getObjectKey(),
                o.getReportCode(),
                o.getJobId(),
                o.getFmt(),
                o.getSizeBytes(),
                o.getCreatedBy(),
                o.getCreatedAt(),
                o.getParams());
    }

    /** Listing shape for {@code GET /outputs}. */
    public record OutputFileDto(
            String objectKey,
            String reportCode,
            String jobId,
            String fmt,
            long sizeBytes,
            String createdBy,
            OffsetDateTime createdAt,
            String params
    ) {}
}
