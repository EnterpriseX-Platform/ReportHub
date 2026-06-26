package io.reporthub.reportstudio.storage;

import io.minio.BucketExistsArgs;
import io.minio.GetObjectArgs;
import io.minio.GetPresignedObjectUrlArgs;
import io.minio.MakeBucketArgs;
import io.minio.MinioClient;
import io.minio.PutObjectArgs;
import io.minio.RemoveObjectArgs;
import io.minio.http.Method;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.time.Duration;
import java.util.concurrent.TimeUnit;

/**
 * Real object storage backed by MinIO (S3 compatible).
 * The target bucket is auto-created on startup.
 */
@Service
public class ObjectStorageService {

    private static final Logger log = LoggerFactory.getLogger(ObjectStorageService.class);

    private final MinioClient client;
    private final String bucket;

    public ObjectStorageService(MinioClient client, MinioProperties props) {
        this.client = client;
        this.bucket = props.getBucket();
    }

    /** Ensure the configured bucket exists on startup. */
    @PostConstruct
    void ensureBucket() {
        try {
            boolean exists = client.bucketExists(BucketExistsArgs.builder().bucket(bucket).build());
            if (!exists) {
                client.makeBucket(MakeBucketArgs.builder().bucket(bucket).build());
                log.info("Created MinIO bucket '{}'", bucket);
            } else {
                log.info("MinIO bucket '{}' already present", bucket);
            }
        } catch (Exception e) {
            throw new ObjectStorageException("Failed to ensure bucket '" + bucket + "'", e);
        }
    }

    /** List all objects under {@code prefix} (recursive). Returns key + size (contentType is null). */
    public java.util.List<StoredObjectMeta> list(String prefix) {
        java.util.List<StoredObjectMeta> out = new java.util.ArrayList<>();
        try {
            Iterable<io.minio.Result<io.minio.messages.Item>> results = client.listObjects(
                    io.minio.ListObjectsArgs.builder().bucket(bucket).prefix(prefix).recursive(true).build());
            for (io.minio.Result<io.minio.messages.Item> r : results) {
                io.minio.messages.Item item = r.get();
                if (!item.isDir()) {
                    out.add(new StoredObjectMeta(item.objectName(), item.size(), null));
                }
            }
            return out;
        } catch (Exception e) {
            throw new ObjectStorageException("Failed to list objects under '" + prefix + "'", e);
        }
    }

    /** Store {@code bytes} under {@code objectKey} and return its metadata. */
    public StoredObjectMeta put(String objectKey, byte[] bytes, String contentType) {
        String ct = (contentType == null || contentType.isBlank())
                ? "application/octet-stream"
                : contentType;
        try (InputStream in = new ByteArrayInputStream(bytes)) {
            client.putObject(PutObjectArgs.builder()
                    .bucket(bucket)
                    .object(objectKey)
                    .stream(in, bytes.length, -1)
                    .contentType(ct)
                    .build());
            return new StoredObjectMeta(objectKey, bytes.length, ct);
        } catch (Exception e) {
            throw new ObjectStorageException("Failed to put object '" + objectKey + "'", e);
        }
    }

    /**
     * Stream a file straight from disk to object storage without loading it into the heap.
     * Used for large query-exports (CSV/XLSX of millions of rows) where a {@code byte[]} would OOM.
     */
    public StoredObjectMeta put(String objectKey, java.nio.file.Path file, String contentType) {
        String ct = (contentType == null || contentType.isBlank())
                ? "application/octet-stream"
                : contentType;
        try (InputStream in = java.nio.file.Files.newInputStream(file)) {
            long size = java.nio.file.Files.size(file);
            client.putObject(PutObjectArgs.builder()
                    .bucket(bucket)
                    .object(objectKey)
                    .stream(in, size, -1)
                    .contentType(ct)
                    .build());
            return new StoredObjectMeta(objectKey, size, ct);
        } catch (Exception e) {
            throw new ObjectStorageException("Failed to put object '" + objectKey + "'", e);
        }
    }

    /** Fetch the full object content for {@code objectKey}. */
    public byte[] get(String objectKey) {
        try (InputStream in = client.getObject(GetObjectArgs.builder()
                .bucket(bucket)
                .object(objectKey)
                .build())) {
            return in.readAllBytes();
        } catch (Exception e) {
            throw new ObjectStorageException("Failed to get object '" + objectKey + "'", e);
        }
    }

    /** Remove an object. Best-effort: a missing object is not an error (idempotent cleanup). */
    public void delete(String objectKey) {
        if (objectKey == null || objectKey.isBlank()) return;
        try {
            client.removeObject(RemoveObjectArgs.builder()
                    .bucket(bucket)
                    .object(objectKey)
                    .build());
        } catch (Exception e) {
            log.warn("Failed to remove object '{}' (ignored): {}", objectKey, e.toString());
        }
    }

    /** Build a time-limited presigned GET URL for {@code objectKey}. */
    public String presignedGetUrl(String objectKey, Duration ttl) {
        int seconds = (int) Math.min(ttl.getSeconds(), Integer.MAX_VALUE);
        try {
            return client.getPresignedObjectUrl(GetPresignedObjectUrlArgs.builder()
                    .method(Method.GET)
                    .bucket(bucket)
                    .object(objectKey)
                    .expiry(seconds, TimeUnit.SECONDS)
                    .build());
        } catch (Exception e) {
            throw new ObjectStorageException("Failed to presign object '" + objectKey + "'", e);
        }
    }
}
