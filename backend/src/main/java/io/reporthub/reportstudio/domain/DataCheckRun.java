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

/** One execution of a {@link DataCheck} — keeps the pass/fail history per check. */
@Entity
@Table(name = "data_check_run")
@Getter
@Setter
public class DataCheckRun {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "check_id", nullable = false)
    private Long checkId;

    @Column(name = "started_at", nullable = false)
    private OffsetDateTime startedAt = OffsetDateTime.now();

    @Column(name = "finished_at")
    private OffsetDateTime finishedAt;

    /** pass | fail | error */
    @Column(nullable = false)
    private String status;

    /** scheduled | manual */
    @Column(name = "trigger", nullable = false)
    private String trigger;

    @Column(name = "row_count")
    private Integer rowCount;

    private String message;

    @Column(name = "run_by")
    private String runBy;

    /**
     * Failing rows of this run, as JSON {@code {"columns":[...],"rows":[[...]]}} · null = the check passed,
     * or an older run from before this column existed.
     *
     * <p>Kept for two reasons: the Findings screen need not re-query on every open, and failures of
     * older runs stay reviewable. Row count is capped; not every failing row is stored.
     */
    @Column(columnDefinition = "text")
    private String findings;

    /**
     * Batch number — one group-wide run gives every check the same number.
     * null = a single run (one check / the scheduler) or an older run from before this column existed.
     */
    @Column(name = "batch_id", length = 40)
    private String batchId;
}
