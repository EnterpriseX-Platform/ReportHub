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

/** One execution of a {@link Scheduler} — success/error, when, and how many rows it affected. */
@Entity
@Table(name = "scheduler_run")
@Getter
@Setter
public class SchedulerRun {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "scheduler_id", nullable = false)
    private Long schedulerId;

    @Column(name = "started_at", nullable = false)
    private OffsetDateTime startedAt;

    @Column(name = "finished_at")
    private OffsetDateTime finishedAt;

    @Column(nullable = false)
    private String status;            // ok | error

    @Column(nullable = false)
    private String trigger;           // scheduled | manual

    private Integer affected;

    @Column(columnDefinition = "TEXT")
    private String message;

    @Column(name = "run_by")
    private String runBy;
}
