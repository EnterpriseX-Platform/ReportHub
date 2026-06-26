package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.Dashboard;

import java.util.List;
import java.util.Optional;

public interface DashboardRepository extends JpaRepository<Dashboard, Long> {
    List<Dashboard> findAllByOrderByUpdatedAtDesc();
    Optional<Dashboard> findByShareToken(String shareToken);
}
