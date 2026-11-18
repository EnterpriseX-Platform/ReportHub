package io.reporthub.reportstudio.web;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import io.reporthub.reportstudio.storage.ObjectStorageException;

import java.util.Map;

/**
 * Cross-cutting exception → HTTP status mappings that need more than a plain
 * {@code @ResponseStatus} (e.g. response headers or a body).
 */
@RestControllerAdvice
public class RestExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(RestExceptionHandler.class);

    /** Seconds a client should wait before retrying after a storage outage. */
    private static final String RETRY_AFTER_SECONDS = "5";

    /**
     * Object storage is unreachable. Outputs are persisted before they are streamed
     * (persist-before-serve), so a MinIO outage would otherwise surface as an opaque 500.
     * Map it to a 503 with {@code Retry-After} so callers know to back off and retry.
     */
    /** Bean-validation failure: list each offending field so the UI can point at it. */
    @ExceptionHandler(org.springframework.web.bind.MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> handleInvalid(org.springframework.web.bind.MethodArgumentNotValidException ex) {
        java.util.Map<String, String> fields = new java.util.LinkedHashMap<>();
        ex.getBindingResult().getFieldErrors().forEach(fe ->
                fields.putIfAbsent(fe.getField(), fe.getDefaultMessage() == null ? "invalid" : fe.getDefaultMessage()));
        String msg = fields.isEmpty() ? "Invalid request"
                : "Invalid field(s): " + String.join(", ", fields.entrySet().stream()
                        .map(e -> e.getKey() + " (" + e.getValue() + ")").toList());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("status", 400, "error", "Bad Request", "message", msg, "fields", fields));
    }

    /**
     * A constraint the request broke (CHECK / FK / NOT NULL / unique). The raw message carries SQL,
     * so return a short generic 400 and keep the detail in the log.
     */
    @ExceptionHandler(org.springframework.dao.DataIntegrityViolationException.class)
    public ResponseEntity<Map<String, Object>> handleIntegrity(org.springframework.dao.DataIntegrityViolationException ex) {
        log.info("Rejected write: {}", ex.getMostSpecificCause().getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of(
                        "status", 400,
                        "error", "Bad Request",
                        "message", "The value is not allowed here (it breaks a data rule or refers to something that does not exist)."));
    }

    @ExceptionHandler(ObjectStorageException.class)
    public ResponseEntity<Map<String, Object>> handleObjectStorage(ObjectStorageException ex) {
        log.warn("Object storage unavailable: {}", ex.getMessage(), ex);
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header(HttpHeaders.RETRY_AFTER, RETRY_AFTER_SECONDS)
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of(
                        "status", HttpStatus.SERVICE_UNAVAILABLE.value(),
                        "error", HttpStatus.SERVICE_UNAVAILABLE.getReasonPhrase(),
                        "message", "Object storage is temporarily unavailable; please retry."));
    }
}
