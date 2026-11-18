package io.reporthub.reportstudio.domain;

import io.reporthub.reportstudio.tenancy.TenantScoped;
import org.hibernate.annotations.Filter;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

import java.time.OffsetDateTime;

/** A registered report definition. Formats are stored as a CSV (e.g. "PDF,XLSX"). */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "report")
@Getter
@Setter
public class Report extends TenantScoped {

    @Id
    private String id;

    @Column(nullable = false, unique = true)
    private String code;

    @Column(name = "name", nullable = false)
    private String name;

    @Column(name = "category_id", nullable = false)
    private String categoryId;

    @Column(nullable = false)
    private String engine;

    @Column(nullable = false)
    private String formats;

    @Column(nullable = false)
    private String status;

    @Column(name = "datasource_id")
    private String datasourceId;

    @Column(name = "template_path")
    private String templatePath;

    @Column(nullable = false)
    private String version;

    @Column(name = "owner_unit")
    private String ownerUnit;

    @Column(name = "avg_ms", nullable = false)
    private int avgMs;

    @Column(nullable = false)
    private int runs;

    @Column(name = "param_count", nullable = false)
    private int paramCount;

    /** Output folder pattern, e.g. "{category}/{yyyy}/{MM}" (placeholders resolved per run). */
    @Column(name = "output_folder")
    private String outputFolder;

    /** Structured engine-specific config (JSON) — edited via the Config screen. */
    @Column(name = "config_json")
    private String configJson;

    /** Whether this report holds test data (shows an acceptance-testing note on the overview). */
    @Column(name = "test_data", nullable = false)
    private boolean testData;

    /**
     * CSV of role codes allowed to see this report in the registry list, e.g.
     * {@code "ADMIN,ANALYST"}. NULL/empty = visible to everyone. Only checked
     * for callers who came through the portal; see {@code ReportSpecs#visibleTo}.
     */
    @Column(name = "allowed_roles")
    private String allowedRoles;

    /** Default queue priority for runs of this report: high | normal | low. */
    @Column(name = "priority", nullable = false)
    private String priority = "normal";

    /** Render time limit for this report in minutes; null = the global limit. */
    @Column(name = "timeout_minutes")
    private Integer timeoutMinutes;

    /** Named queue / worker pool label (informational; all runs use the shared job queue). */
    @Column(name = "queue")
    private String queue;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    /** Automatic delivery after each render: FileHub connector id (null = off). */
    @Column(name = "delivery_connector_id", length = 64)
    private String deliveryConnectorId;

    /** Folder path template for delivery, e.g. {code}/{yyyy}/{mm}. */
    @Column(name = "delivery_path", length = 400)
    private String deliveryPath;
}
