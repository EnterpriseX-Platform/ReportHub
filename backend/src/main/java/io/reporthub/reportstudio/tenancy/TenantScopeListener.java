package io.reporthub.reportstudio.tenancy;

import jakarta.persistence.PostLoad;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;

/**
 * Stamps new rows with the active scope and guards loads by primary key (Hibernate filters do
 * not apply to {@code find()}), so a guessed id from another tenant/project reads as "not found".
 */
public class TenantScopeListener {

    @PrePersist
    public void stamp(TenantScoped e) {
        TenantContext.Scope s = TenantContext.current().orElse(null);
        if (e.getTenantId() == null || e.getTenantId().isBlank()) {
            e.setTenantId(s != null ? s.tenantId() : TenantContext.DEFAULT_TENANT);
        }
        if (e.getProjectId() == null || e.getProjectId().isBlank()) {
            e.setProjectId(s != null ? s.projectId() : TenantContext.DEFAULT_PROJECT);
        }
        guard(e);
    }

    @PreUpdate
    @PostLoad
    public void guard(TenantScoped e) {
        TenantContext.current().ifPresent(s -> {
            if (!s.tenantId().equals(e.getTenantId()) || !s.projectId().equals(e.getProjectId())) {
                throw new OutOfScopeException(e.getClass().getSimpleName());
            }
        });
    }
}
