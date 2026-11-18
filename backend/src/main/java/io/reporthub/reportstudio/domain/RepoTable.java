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

/** A table an admin has put on a data screen, so the screen is not the whole catalogue. */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "repo_table")
@Getter
@Setter
public class RepoTable extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    /** Portal menu that opens this entry — the identity service menu path carries {@code ?menu=<key>}. */
    @Column(name = "menu_key")
    private String menuKey;

    @Column(nullable = false)
    private String label;

    /**
     * Legacy '/'-separated grouping path — since V53 the screen uses {@link #folderId} instead.
     * Kept as a record of which folder an entry used to be in; no longer used to draw the screen.
     */
    private String folder;

    /** Folder this entry lives in (repo_folder.id); null = no folder. */
    @Column(name = "folder_id")
    private Integer folderId;

    @Column(name = "datasource_id", nullable = false)
    private String datasourceId;

    @Column(name = "schema_name")
    private String schemaName;

    @Column(name = "table_name", nullable = false)
    private String tableName;

    /** Fixed slice for this entry: {@code COLUMN=value} pairs separated by ';'. */
    @Column(name = "eq_filter")
    private String eqFilter;

    /** CSV of columns the screen offers as user-selectable filters; null = none. */
    @Column(name = "filter_columns")
    private String filterColumns;

    /** Display column order (COL[,COL]>AFTER_COL separated by ;) — does not change the real column order. */
    @Column(name = "column_order")
    private String columnOrder;

    /**
     * Column headers used when exporting, when they differ from the database names — {@code COLUMN=name} separated by ,
     *
     * <p>E.g. {@code <column>=<header>} when a downstream file spec names a field differently.
     * The screen still shows the real names so people working with the table are not confused.
     */
    @Column(name = "column_labels")
    private String columnLabels;

    /**
     * Columns that exist in the table but are not shown (separated by ,) — null = show all.
     *
     * <p>Hides them from display and exported files only; the data is intact and key columns are still read
     * to identify rows for edit/delete (e.g. a table keyed by a hidden ROW_NO column).
     */
    @Column(name = "hidden_columns")
    private String hiddenColumns;

    /**
     * Columns that identify a row when the table declares no primary key (CSV). Without it the
     * screen can only read: it has nothing to put in the WHERE of an update or delete.
     */
    @Column(name = "key_columns")
    private String keyColumns;

    /** Column holding the year for the optional year picker / export year filter; null = none. */
    @Column(name = "year_column")
    private String yearColumn;

    @Column(name = "sort_order", nullable = false)
    private int sortOrder;

    @Column(name = "is_active", nullable = false)
    private boolean active = true;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt = OffsetDateTime.now();
}
