package io.reporthub.reportstudio.storage;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Binds the {@code minio.*} application properties. */
@ConfigurationProperties(prefix = "minio")
public class MinioProperties {

    /** S3-compatible endpoint, e.g. http://localhost:9000 */
    private String endpoint = "http://localhost:9000";

    /** Access key (MinIO root user). */
    private String accessKey = "reportstudio";

    /** Secret key (MinIO root password). */
    private String secretKey = "reportstudio";

    /** Bucket that report outputs are stored in; auto-created on startup. */
    private String bucket = "report-outputs";

    public String getEndpoint() {
        return endpoint;
    }

    public void setEndpoint(String endpoint) {
        this.endpoint = endpoint;
    }

    public String getAccessKey() {
        return accessKey;
    }

    public void setAccessKey(String accessKey) {
        this.accessKey = accessKey;
    }

    public String getSecretKey() {
        return secretKey;
    }

    public void setSecretKey(String secretKey) {
        this.secretKey = secretKey;
    }

    public String getBucket() {
        return bucket;
    }

    public void setBucket(String bucket) {
        this.bucket = bucket;
    }
}
