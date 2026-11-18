package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.CheckGroupScope;

public interface CheckGroupScopeRepository extends JpaRepository<CheckGroupScope, String> {
}
