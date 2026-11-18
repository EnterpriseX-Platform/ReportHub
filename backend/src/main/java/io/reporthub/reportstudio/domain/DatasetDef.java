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

/** A user-defined dataset: a SELECT query against a datasource, used by Ad-hoc & dashboards. */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "dataset_def")
@Getter
@Setter
public class DatasetDef extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    private String description;

    /** '/'-separated path for the dataset tree; null = ungrouped. */
    private String folder;

    @Column(name = "datasource_id")
    private String datasourceId;

    @Column(name = "sql_text", nullable = false)
    private String sqlText;

    /** live = query the source each use; captured = read the local snapshot table. */
    @Column(name = "capture_mode", nullable = false)
    private String captureMode = "live";

    @Column(name = "captured_at")
    private OffsetDateTime capturedAt;

    @Column(name = "capture_rows")
    private Integer captureRows;

    /** Column metadata frozen at capture time: JSON [{name,kind}]. */
    @Column(name = "columns_json")
    private String columnsJson;

    /** Numeric columns treated as dimensions (CSV, case-insensitive); null = none. */
    @Column(name = "dimension_columns")
    private String dimensionColumns;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;
}
