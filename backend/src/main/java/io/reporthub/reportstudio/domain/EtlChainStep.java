package io.reporthub.reportstudio.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

/** One position in a chain, pointing at either a pipeline or a check (never both). */
@Entity
@Table(name = "etl_chain_step")
@Getter
@Setter
public class EtlChainStep {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "chain_id", nullable = false)
    private Long chainId;

    @Column(name = "step_no", nullable = false)
    private int stepNo;

    @Column(nullable = false)
    private String kind;              // pipeline | check | statement

    @Column(name = "pipeline_id")
    private Long pipelineId;

    @Column(name = "check_id")
    private Long checkId;

    @Column(name = "scheduler_id")
    private Long schedulerId;

    /** Per-type program for an inline step, as JSON; null for the referential kinds. */
    @Column(columnDefinition = "TEXT")
    private String config;

    /** Optional display name; falls back to the executor's own label. */
    private String label;

    /** Name this step's output is published under, for {{name.field}} in later steps. */
    @Column(name = "var_name")
    private String varName;

    /** What a failed step does to the rest of the chain. */
    @Column(name = "on_fail", nullable = false)
    private String onFail = "stop";   // stop | continue
}
