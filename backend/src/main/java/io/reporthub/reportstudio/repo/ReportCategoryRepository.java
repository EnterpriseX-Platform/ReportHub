package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.ReportCategory;

import java.util.List;

public interface ReportCategoryRepository extends JpaRepository<ReportCategory, String> {
    List<ReportCategory> findAllByOrderBySortOrderAsc();
}
