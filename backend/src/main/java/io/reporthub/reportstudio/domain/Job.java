package io.reporthub.reportstudio.domain;

import io.reporthub.reportstudio.tenancy.TenantScoped;
import org.hibernate.annotations.Filter;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

import java.time.OffsetDateTime;

/** A gateway job. The job table is also the render queue (see {@code JobQueue}). */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "job")
@Getter
@Setter
public class Job extends TenantScoped {

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

    /** Full captured run log for a failed job (cause chain + stack trace + recent log lines). */
    @Column(name = "error_detail", columnDefinition = "TEXT")
    private String errorDetail;

    /** JSON render envelope ({@code JobMessage} without the caller token). */
    @Column(columnDefinition = "TEXT")
    private String payload;

    /** SENSITIVE short-lived caller token; cleared when a worker claims the job. Never log it. */
    @Column(name = "caller_token", columnDefinition = "TEXT")
    private String callerToken;

    /** Worker instance that claimed the job (null while queued). */
    @Column(name = "claimed_by")
    private String claimedBy;

    @Column(name = "claimed_at")
    private OffsetDateTime claimedAt;

    /**
     * Bumped periodically by the owning worker while the job renders. Written ONLY by SQL in
     * {@code JobQueue} (claim + heartbeat): the worker saves its long-lived Job entity many times during a
     * render, and letting JPA write this column would roll the heartbeat back to the claim time.
     */
    @Column(name = "heartbeat_at", insertable = false, updatable = false)
    private OffsetDateTime heartbeatAt;

    /** Snapshot of the submitting principal (roles, attributes) for row filters in the worker. */
    @Column(name = "principal_json", columnDefinition = "TEXT")
    private String principalJson;

    /** Non-fatal problem of a finished job (e.g. FileHub delivery failed). */
    @Column(name = "warning", columnDefinition = "TEXT")
    private String warning;
}
