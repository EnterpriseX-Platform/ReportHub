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
 * What one step of one round did. {@code refName} is a snapshot of the pipeline/check name at run
 * time — a round from three months ago still reads correctly after the pipeline behind it is
 * renamed, and the id links stay for anyone who wants the underlying run row.
 */
@Entity
@Table(name = "etl_chain_run_step")
@Getter
@Setter
public class EtlChainRunStep {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "run_id", nullable = false)
    private Long runId;

    @Column(name = "step_no", nullable = false)
    private int stepNo;

    @Column(nullable = false)
    private String kind;

    @Column(name = "ref_name")
    private String refName;

    @Column(nullable = false)
    private String status;            // running | success | failed | skipped

    @Column(name = "rows_read")
    private Integer rowsRead;

    @Column(name = "rows_written")
    private Integer rowsWritten;

    @Column(name = "check_count")
    private Integer checkCount;

    @Column(name = "check_pass")
    private Boolean checkPass;

    @Column(name = "warehouse_run_id")
    private Long warehouseRunId;

    @Column(name = "data_check_run_id")
    private Long dataCheckRunId;

    @Column(name = "scheduler_run_id")
    private Long schedulerRunId;

    /** Rows written by a statement step; null for a PL/SQL block, which reports no count. */
    private Integer affected;

    @Column(columnDefinition = "TEXT")
    private String message;

    @Column(name = "started_at", nullable = false)
    private OffsetDateTime startedAt = OffsetDateTime.now();

    @Column(name = "finished_at")
    private OffsetDateTime finishedAt;
}
