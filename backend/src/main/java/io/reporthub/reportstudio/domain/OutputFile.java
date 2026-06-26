package io.reporthub.reportstudio.domain;

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
@Table(name = "output_file")
@Getter
@Setter
public class OutputFile {

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
}
