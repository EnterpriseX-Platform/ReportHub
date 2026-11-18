package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.ReportParam;

import java.util.List;

public interface ReportParamRepository extends JpaRepository<ReportParam, ReportParam.Key> {
    List<ReportParam> findByReportCodeOrderBySortOrderAsc(String reportCode);
    void deleteByReportCode(String reportCode);
    long countByParamName(String paramName);
}
