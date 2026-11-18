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
 * One round: the chain executed for one fiscal year. {@code roundNo} counts within
 * (chain, fiscalYear), so a year that has to be redone several times keeps every attempt
 * distinguishable rather than overwriting the last one.
 */
@Entity
@Table(name = "etl_chain_run")
@Getter
@Setter
public class EtlChainRun {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "chain_id", nullable = false)
    private Long chainId;

    @Column(name = "fiscal_year")
    private String fiscalYear;

    @Column(name = "round_no", nullable = false)
    private int roundNo;

    @Column(nullable = false)
    private String status;            // running | success | failed | partial

    @Column(name = "started_at", nullable = false)
    private OffsetDateTime startedAt = OffsetDateTime.now();

    @Column(name = "finished_at")
    private OffsetDateTime finishedAt;

    /** The run this one was resumed from ("Resume") — null = a normal run starting at the first step. */
    @Column(name = "resumed_from_run_id")
    private Long resumedFromRunId;

    /** First step this run actually executed — earlier steps are recorded as skipped "passed in previous run". */
    @Column(name = "start_step_no", nullable = false)
    private int startStepNo = 1;

    @Column(name = "run_by")
    private String runBy;

    @Column(columnDefinition = "TEXT")
    private String message;
}
