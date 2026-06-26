package io.reporthub.reportstudio.render;

/**
 * Thrown when a report cannot be rendered (template compile failure, SQL error,
 * export failure, unsupported format, etc.). Unchecked so callers can map it to an
 * HTTP 500 / problem response in the web layer without checked-exception plumbing.
 */
public class RenderException extends RuntimeException {

    public RenderException(String message) {
        super(message);
    }

    public RenderException(String message, Throwable cause) {
        super(message, cause);
    }
}
