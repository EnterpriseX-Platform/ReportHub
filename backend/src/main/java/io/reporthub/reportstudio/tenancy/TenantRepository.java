package io.reporthub.reportstudio.tenancy;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface TenantRepository extends JpaRepository<Tenant, String> {
    Optional<Tenant> findByIamTenantId(String iamTenantId);
}
