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

/** One execution of a {@link WarehousePipeline} — rows read/written, status, and when. */
@Entity
@Table(name = "warehouse_run")
@Getter
@Setter
public class WarehouseRun {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "pipeline_id", nullable = false)
    private Long pipelineId;

    @Column(name = "started_at", nullable = false)
    private OffsetDateTime startedAt;

    @Column(name = "finished_at")
    private OffsetDateTime finishedAt;

    @Column(nullable = false)
    private String status;            // ok | error

    @Column(nullable = false)
    private String trigger;           // scheduled | manual

    @Column(name = "rows_read")
    private Integer rowsRead;

    @Column(name = "rows_written")
    private Integer rowsWritten;

    @Column(columnDefinition = "TEXT")
    private String message;

    @Column(name = "run_by")
    private String runBy;
}
