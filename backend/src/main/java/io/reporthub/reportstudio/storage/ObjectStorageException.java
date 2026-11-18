package io.reporthub.reportstudio.storage;

/** Unchecked wrapper for any failure interacting with the object store. */
public class ObjectStorageException extends RuntimeException {

    public ObjectStorageException(String message, Throwable cause) {
        super(message, cause);
    }
}
