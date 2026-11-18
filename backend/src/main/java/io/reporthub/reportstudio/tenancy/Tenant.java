package io.reporthub.reportstudio.tenancy;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;
import org.hibernate.annotations.FilterDef;
import org.hibernate.annotations.ParamDef;

import java.time.OffsetDateTime;

/**
 * A tenant. {@code id} is the tenant code. {@code iamTenantId} links it to the IAM service's
 * tenant (uuid) so an IAM login lands in the right tenant.
 *
 * <p>Also hosts the {@code tenantScope} filter definition used by every {@link TenantScoped} entity.
 */
@Entity
@Table(name = "tenant")
@FilterDef(name = TenantScoped.FILTER,
        defaultCondition = TenantScoped.FILTER_CONDITION,
        parameters = {@ParamDef(name = "tenantId", type = String.class),
                      @ParamDef(name = "projectId", type = String.class)})
@Getter
@Setter
public class Tenant {

    @Id
    @Column(length = 64)
    private String id;

    @Column(nullable = false, length = 200)
    private String name;

    @Column(name = "iam_tenant_id", length = 64)
    private String iamTenantId;

    @Column(nullable = false)
    private boolean active = true;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();
}
