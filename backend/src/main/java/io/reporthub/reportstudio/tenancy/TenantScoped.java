package io.reporthub.reportstudio.tenancy;

import jakarta.persistence.Column;
import jakarta.persistence.EntityListeners;
import jakarta.persistence.MappedSuperclass;
import lombok.Getter;
import lombok.Setter;

/**
 * Base class of every tenant/project-owned entity. Subclasses also carry
 * {@code @Filter(name = TenantScoped.FILTER)} so the Hibernate filter defined on {@link Tenant}
 * applies to their queries.
 */
@MappedSuperclass
@EntityListeners(TenantScopeListener.class)
@Getter
@Setter
public abstract class TenantScoped {

    public static final String FILTER = "tenantScope";
    public static final String FILTER_CONDITION = "tenant_id = :tenantId and project_id = :projectId";

    @Column(name = "tenant_id", nullable = false, length = 64)
    private String tenantId;

    @Column(name = "project_id", nullable = false, length = 64)
    private String projectId;
}
