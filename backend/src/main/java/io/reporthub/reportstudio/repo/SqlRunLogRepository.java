package io.reporthub.reportstudio.repo;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.SqlRunLog;

import java.util.List;

public interface SqlRunLogRepository extends JpaRepository<SqlRunLog, Long> {

    List<SqlRunLog> findAllByOrderByCreatedAtDesc(Pageable page);

    List<SqlRunLog> findByCreatedByOrderByCreatedAtDesc(String createdBy, Pageable page);
}
