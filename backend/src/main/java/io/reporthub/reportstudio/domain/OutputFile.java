package io.reporthub.reportstudio.domain;

import io.reporthub.reportstudio.tenancy.TenantScoped;
import org.hibernate.annotations.Filter;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

import java.time.OffsetDateTime;

/** A generated report output persisted in object storage (MinIO). */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "output_file")
@Getter
@Setter
public class OutputFile extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "object_key", nullable = false, unique = true)
    private String objectKey;

    @Column(name = "report_code", nullable = false)
    private String reportCode;

    @Column(name = "job_id")
    private String jobId;

    @Column(name = "fmt", nullable = false)
    private String fmt;

    @Column(name = "size_bytes", nullable = false)
    private long sizeBytes;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    /** Run parameters used to produce this output, serialized as JSON (e.g. {"YEAR":"2025"}). */
    @Column(name = "params", columnDefinition = "TEXT")
    private String params;

    /**
     * Share link token for this file — null = not shared; unsharing resets it to null.
     *
     * <p>One link per file (by design). If multiple links per file or per-person permissions are needed
     * later, split into a separate share table.
     */
    @Column(name = "share_token", length = 64)
    private String shareToken;

    /** null = never expires */
    @Column(name = "share_expires_at")
    private OffsetDateTime shareExpiresAt;

    @Column(name = "shared_by")
    private String sharedBy;

    @Column(name = "shared_at")
    private OffsetDateTime sharedAt;

    /** How many times the link was opened — so you know its usage before revoking it. */
    @Column(name = "share_hits", nullable = false)
    private int shareHits = 0;

    /** FileHub publication (null = not published). */
    @Column(name = "filehub_connector_id", length = 64)
    private String filehubConnectorId;

    @Column(name = "filehub_file_id", length = 128)
    private String filehubFileId;

    @Column(name = "filehub_url", columnDefinition = "TEXT")
    private String filehubUrl;

    @Column(name = "filehub_published_at")
    private OffsetDateTime filehubPublishedAt;
}
