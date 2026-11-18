package io.reporthub.reportstudio.domain;

import io.reporthub.reportstudio.tenancy.TenantScoped;
import org.hibernate.annotations.Filter;
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
@Filter(name = TenantScoped.FILTER)
@Table(name = "warehouse_pipeline")
@Getter
@Setter
public class WarehousePipeline extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    private String description;

    /** '/'-separated path for the pipeline tree; null = ungrouped. */
    private String folder;

    @Column(name = "source_datasource_id")
    private String sourceDatasourceId;

    @Column(name = "source_sql", nullable = false)
    private String sourceSql;

    /** Year substituted into $YEAR4/$YEAR2 in {@link #sourceSql} on a scheduled run. */
    @Column(name = "fiscal_year")
    private String fiscalYear;

    @Column(name = "target_datasource_id")
    private String targetDatasourceId;

    /** Schema of the target table; null = the target connection's own schema. */
    @Column(name = "target_schema")
    private String targetSchema;

    @Column(name = "target_table", nullable = false)
    private String targetTable;

    /** replace = truncate+insert · append = insert · upsert = delete-by-key+insert. */
    @Column(name = "load_mode", nullable = false)
    private String loadMode = "replace";

    /** How Replace empties the target: {@code delete} (transactional) or {@code truncate} (fast). */
    @Column(name = "clear_mode", nullable = false)
    private String clearMode = "delete";

    /** CSV of key columns; required for upsert. */
    @Column(name = "key_columns")
    private String keyColumns;

    /**
     * Replace mode only: when set, the load deletes just the rows matching this predicate instead
     * of emptying the target — so several pipelines can own different slices of one table, which is
     * e.g. several processing stages sharing one staging table. NULL keeps whole-table behaviour.
     */
    @Column(name = "clear_where")
    private String clearWhere;

    /**
     * Parameters this pipeline asks for when it is run: {@code [{"name","label","default"}]}.
     * {@code $NAME} is substituted into {@link #sourceSql} and {@link #clearWhere}. The fiscal year
     * is not listed here — {@code $YEAR4}/{@code $YEAR2} are built in and always offered.
     */
    @Column(name = "params_json")
    private String paramsJson;

    /**
     * Control-total column in the result (e.g. P_TOTAL_AMT) - when set, every run compares "rows + sum"
     * between the target (scoped by clearWhere) and the source query and stores the result with the run. NULL = no check.
     */
    @Column(name = "control_column")
    private String controlColumn;

    /** Accepted difference in the total - row counts must always match exactly, no tolerance. */
    @Column(name = "control_tolerance", nullable = false)
    private java.math.BigDecimal controlTolerance = java.math.BigDecimal.ZERO;

    @Column(name = "auto_create", nullable = false)
    private boolean autoCreate = true;

    /** Widen an existing target with columns the query has and the table does not. */
    @Column(name = "add_columns", nullable = false)
    private boolean addColumns = false;

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
