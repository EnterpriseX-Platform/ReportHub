package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.ReportFlow;

public interface ReportFlowRepository extends JpaRepository<ReportFlow, String> {
}
