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
 * One render unit of a report. A report may have several units — each with its own engine,
 * output format and template files — and a single run call executes them all.
 */
@Entity
@Table(name = "report_unit")
@Getter
@Setter
public class ReportUnit {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "report_code", nullable = false)
    private String reportCode;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private String engine;

    /** Output format override for this unit (NULL = use the job's requested format). */
    private String fmt;

    @Column(name = "config_json")
    private String configJson;

    /** Datasource override for this unit (NULL = report's datasource). */
    @Column(name = "datasource_id")
    private String datasourceId;

    @Column(name = "sort_order", nullable = false)
    private int sortOrder;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;
}
