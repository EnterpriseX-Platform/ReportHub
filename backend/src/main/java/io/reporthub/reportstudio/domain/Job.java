package io.reporthub.reportstudio.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

import java.time.OffsetDateTime;

/** A gateway job (Kafka report.jobs lifecycle). */
@Entity
@Table(name = "job")
@Getter
@Setter
public class Job {

    @Id
    private String id;

    @Column(name = "report_code", nullable = false)
    private String reportCode;

    @Column(name = "report_name", nullable = false)
    private String reportName;

    @Column(nullable = false)
    private String stage;

    @Column(nullable = false)
    private String state;

    @Column(nullable = false)
    private String fmt;

    @Column(name = "datasource_id")
    private String datasourceId;

    @Column(name = "requested_by")
    private String requestedBy;

    @Column(name = "started_at", nullable = false)
    private OffsetDateTime startedAt;

    @Column(nullable = false)
    private int progress;

    @Column(name = "partition", nullable = false)
    private int partition;

    @Column(nullable = false)
    private String priority;

    @Column(name = "error_message", columnDefinition = "TEXT")
    private String errorMessage;
}
