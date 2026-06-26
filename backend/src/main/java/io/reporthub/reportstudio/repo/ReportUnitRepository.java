package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.ReportUnit;

import java.util.List;

public interface ReportUnitRepository extends JpaRepository<ReportUnit, Long> {
    List<ReportUnit> findByReportCodeOrderBySortOrderAscIdAsc(String reportCode);
    List<ReportUnit> findByReportCodeAndEnabledTrueOrderBySortOrderAscIdAsc(String reportCode);
    long countByReportCode(String reportCode);
}
