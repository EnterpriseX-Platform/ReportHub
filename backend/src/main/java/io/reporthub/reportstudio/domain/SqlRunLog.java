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
 * One row per statement run from the free-form SQL box — both successes and failures.
 *
 * <p>The box can really run INSERT/UPDATE/DELETE/MERGE and PL/SQL blocks, so knowing who ran what, when,
 * against which database, how long it took and what happened is not decoration — it is the only way to
 * trace back when data changes and nobody knows why.
 */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "sql_run_log")
@Getter
@Setter
public class SqlRunLog extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "datasource_id")
    private String datasourceId;

    /** select · update · block — as decided by RepositoryService.classify */
    @Column(name = "statement_kind", nullable = false)
    private String statementKind;

    @Column(name = "sql_text", nullable = false)
    private String sqlText;

    @Column(name = "row_count")
    private Integer rowCount;

    private Integer affected;

    @Column(name = "duration_ms", nullable = false)
    private int durationMs;

    /** ok · error */
    @Column(nullable = false)
    private String status;

    @Column(name = "error_text")
    private String errorText;

    /** Screen the run came from — adhoc · tables */
    private String source;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;
}
