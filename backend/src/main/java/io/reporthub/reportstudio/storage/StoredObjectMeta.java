package io.reporthub.reportstudio.storage;

/** Metadata returned after an object is stored. */
public record StoredObjectMeta(String objectKey, long sizeBytes, String contentType) {
}
