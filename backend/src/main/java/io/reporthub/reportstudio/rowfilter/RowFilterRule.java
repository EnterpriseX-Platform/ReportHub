package io.reporthub.reportstudio.rowfilter;

import io.reporthub.reportstudio.tenancy.TenantScoped;
import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import org.hibernate.annotations.Filter;

import java.time.OffsetDateTime;

/**
 * Level 3: one row-level rule on a data object. Rows pass when {@code column operator value};
 * {@code valueExpr} may reference user attributes, e.g. {@code ${user.departmentCode}}.
 * All rules of an object that apply to the caller are AND-ed.
 */
@Entity
@Table(name = "row_filter_rule")
@Filter(name = TenantScoped.FILTER)
@Getter
@Setter
public class RowFilterRule extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** REPORT | DATASET | REPO_TABLE */
    @Column(name = "object_type", nullable = false, length = 32)
    private String objectType;

    @Column(name = "object_id", nullable = false, length = 200)
    private String objectId;

    @Column(name = "column_name", nullable = false, length = 128)
    private String columnName;

    @Column(nullable = false, length = 16)
    private String operator;

    @Column(name = "value_expr", length = 1000)
    private String valueExpr;

    /** text | number */
    @Column(name = "value_type", nullable = false, length = 16)
    private String valueType = "text";

    /** Optional: only callers holding this principal get the rule (null = everyone). */
    @Column(name = "principal_type", length = 32)
    private String principalType;

    @Column(name = "principal_code", length = 200)
    private String principalCode;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "created_by", length = 200)
    private String createdBy;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt = OffsetDateTime.now();
}
