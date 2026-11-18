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
 * A data check: a SELECT that returns the rows which are <em>wrong</em>. Zero rows means pass.
 *
 * <p>Writing the rule as "what must never appear" is what lets the screen report pass/fail without
 * understanding the rule, and show the offending rows from the very same query when it fails.
 */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "data_check")
@Getter
@Setter
public class DataCheck extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    private String description;

    /** '/'-separated path for the check tree; null = ungrouped. */
    private String folder;

    @Column(name = "datasource_id")
    private String datasourceId;

    @Column(name = "sql_text", nullable = false)
    private String sqlText;

    /** Substituted into $YEAR4/$YEAR2 in {@link #sqlText} on a scheduled run. */
    @Column(name = "fiscal_year")
    private String fiscalYear;

    /** Fail when the row count exceeds this; 0 means the result must be empty. */
    @Column(name = "max_rows", nullable = false)
    private int maxRows;

    @Column(nullable = false)
    private boolean enabled = true;

    private String cron;

    @Column(name = "next_run_at")
    private OffsetDateTime nextRunAt;

    @Column(name = "last_run_at")
    private OffsetDateTime lastRunAt;

    /** pass | fail | error | running */
    @Column(name = "last_status")
    private String lastStatus;

    @Column(name = "last_count")
    private Integer lastCount;

    @Column(name = "last_error")
    private String lastError;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt = OffsetDateTime.now();
}
