package io.reporthub.reportstudio.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

/**
 * One step in a {@link WarehousePipeline} chain.
 *
 * <p>A pipeline is a "sequence of steps", not a single load - a one-step pipeline is still a chain,
 * just a shorter one, so the system needs only one concept.
 */
@Entity
@Table(name = "warehouse_pipeline_step")
@Getter
@Setter
public class WarehousePipelineStep {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "pipeline_id", nullable = false)
    private Long pipelineId;

    /** Execution order - gaps allowed, must be unique within a chain. */
    @Column(name = "step_no", nullable = false)
    private int stepNo;

    /** load | sql | check | assert */
    @Column(nullable = false)
    private String kind;

    private String label;

    /** This step's own program, JSON whose shape depends on {@link #kind}. */
    @Column(columnDefinition = "TEXT")
    private String config;

    /** stop = halt the whole chain (default); continue = move on to the next step. */
    @Column(name = "on_fail", nullable = false)
    private String onFail = "stop";

    /** Variable name under which this step publishes its result for later steps, referenced as {@code {{name}}}. */
    @Column(name = "var_name")
    private String varName;
}
