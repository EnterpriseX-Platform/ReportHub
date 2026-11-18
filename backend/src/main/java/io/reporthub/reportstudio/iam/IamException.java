package io.reporthub.reportstudio.iam;

/** IAM call failed. {@code status} is the HTTP status from IAM, or 0 when it could not be reached. */
public class IamException extends RuntimeException {
    private final int status;
    public IamException(int status, String message) { super(message); this.status = status; }
    public IamException(String message, Throwable cause) { super(message, cause); this.status = 0; }
    public int status() { return status; }
}
