package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.Workspace;

public interface WorkspaceRepository extends JpaRepository<Workspace, Long> {
}
