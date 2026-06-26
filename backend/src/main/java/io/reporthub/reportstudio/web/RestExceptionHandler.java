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
    @ExceptionHandler(ObjectStorageException.class)
    public ResponseEntity<Map<String, Object>> handleObjectStorage(ObjectStorageException ex) {
        log.warn("Object storage unavailable: {}", ex.getMessage());
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header(HttpHeaders.RETRY_AFTER, RETRY_AFTER_SECONDS)
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of(
                        "status", HttpStatus.SERVICE_UNAVAILABLE.value(),
                        "error", HttpStatus.SERVICE_UNAVAILABLE.getReasonPhrase(),
                        "message", "Object storage is temporarily unavailable; please retry."));
    }
}
