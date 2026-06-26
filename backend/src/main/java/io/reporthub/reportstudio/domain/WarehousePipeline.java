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
 * A data-warehouse ETL pipeline: read rows from a source datasource (a SELECT with conditions) and
 * load them into a target table on any datasource (Replace / Append / Upsert-by-key), optionally on
 * a cron schedule. {@code nextRunAt} is recomputed from {@code cron} each fire.
 */
@Entity
@Table(name = "warehouse_pipeline")
@Getter
@Setter
public class WarehousePipeline {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    private String description;

    @Column(name = "source_datasource_id")
    private String sourceDatasourceId;

    @Column(name = "source_sql", nullable = false)
    private String sourceSql;

    @Column(name = "target_datasource_id")
    private String targetDatasourceId;

    @Column(name = "target_table", nullable = false)
    private String targetTable;

    /** replace = truncate+insert · append = insert · upsert = delete-by-key+insert. */
    @Column(name = "load_mode", nullable = false)
    private String loadMode = "replace";

    /** CSV of key columns; required for upsert. */
    @Column(name = "key_columns")
    private String keyColumns;

    @Column(name = "auto_create", nullable = false)
    private boolean autoCreate = true;

    /** Spring 6-field cron, or null for manual-only. */
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

    @Column(name = "last_rows_read")
    private Integer lastRowsRead;

    @Column(name = "last_rows_written")
    private Integer lastRowsWritten;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;
}
