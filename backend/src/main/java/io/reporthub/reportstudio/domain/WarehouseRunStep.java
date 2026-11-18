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

/** Result of one step in one round; the row is written when the step starts (status=running), not when it ends. */
@Entity
@Table(name = "warehouse_run_step")
@Getter
@Setter
public class WarehouseRunStep {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "run_id", nullable = false)
    private Long runId;

    @Column(name = "step_no", nullable = false)
    private int stepNo;

    @Column(nullable = false)
    private String kind;

    private String label;

    /** running | success | failed | skipped | cancelled */
    @Column(nullable = false)
    private String status;

    @Column(name = "rows_read")
    private Integer rowsRead;

    @Column(name = "rows_written")
    private Integer rowsWritten;

    private Integer affected;

    @Column(columnDefinition = "TEXT")
    private String message;

    @Column(name = "started_at", nullable = false)
    private OffsetDateTime startedAt = OffsetDateTime.now();

    @Column(name = "finished_at")
    private OffsetDateTime finishedAt;
}
