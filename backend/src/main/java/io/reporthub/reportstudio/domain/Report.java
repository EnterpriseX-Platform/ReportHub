package io.reporthub.reportstudio.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

import java.time.OffsetDateTime;

/** A registered report definition. Formats are stored as a CSV (e.g. "PDF,XLSX"). */
@Entity
@Table(name = "report")
@Getter
@Setter
public class Report {

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

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;
}
