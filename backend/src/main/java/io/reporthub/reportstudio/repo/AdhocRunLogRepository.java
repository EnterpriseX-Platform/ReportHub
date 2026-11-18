package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.AdhocRunLog;

import java.util.List;

public interface AdhocRunLogRepository extends JpaRepository<AdhocRunLog, Long> {
    List<AdhocRunLog> findTop10ByOrderByCreatedAtDesc();
}
