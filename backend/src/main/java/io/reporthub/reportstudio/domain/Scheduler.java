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

/**
 * A scheduled SQL job: runs a single INSERT/UPDATE/DELETE/MERGE against a datasource on
 * a cron schedule. {@code nextRunAt} is recomputed from {@code cron} each time it fires.
 */
@Entity
@Table(name = "scheduler")
@Getter
@Setter
public class Scheduler {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    private String description;

    @Column(name = "datasource_id")
    private String datasourceId;

    @Column(name = "sql_text", nullable = false)
    private String sqlText;

    /** Spring 6-field cron: {@code sec min hour day-of-month month day-of-week}. */
    @Column(nullable = false)
    private String cron;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "next_run_at")
    private OffsetDateTime nextRunAt;

    @Column(name = "last_run_at")
    private OffsetDateTime lastRunAt;

    @Column(name = "last_status")
    private String lastStatus;

    @Column(name = "last_error")
    private String lastError;

    @Column(name = "last_affected")
    private Integer lastAffected;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;
}
