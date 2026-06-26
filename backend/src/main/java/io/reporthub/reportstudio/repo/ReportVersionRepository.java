package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.ReportVersion;

import java.util.List;

public interface ReportVersionRepository extends JpaRepository<ReportVersion, Long> {
    List<ReportVersion> findByReportCodeOrderByCreatedAtDesc(String reportCode);
}
