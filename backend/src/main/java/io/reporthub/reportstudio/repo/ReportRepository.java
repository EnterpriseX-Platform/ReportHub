package io.reporthub.reportstudio.repo;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import io.reporthub.reportstudio.domain.Report;

import java.util.List;
import java.util.Optional;

public interface ReportRepository extends JpaRepository<Report, String>, JpaSpecificationExecutor<Report> {

    Optional<Report> findByCode(String code);

    boolean existsByCode(String code);

    /** Registered report count per category. */
    @Query("SELECT r.categoryId AS categoryId, COUNT(r) AS count FROM Report r GROUP BY r.categoryId")
    List<CategoryCount> countByCategory();

    /** Report count per status. */
    @Query("SELECT r.status AS status, COUNT(r) AS count FROM Report r GROUP BY r.status")
    List<StatusCount> countByStatus();

    /** Report count per engine. */
    @Query("SELECT r.engine AS engine, COUNT(r) AS count FROM Report r GROUP BY r.engine")
    List<EngineCount> countByEngine();

    long countByDatasourceId(String datasourceId);

    long countByCategoryId(String categoryId);

    List<Report> findTop8ByOrderByUpdatedAtDesc();

    interface CategoryCount { String getCategoryId(); long getCount(); }
    interface StatusCount   { String getStatus();     long getCount(); }
    interface EngineCount   { String getEngine();     long getCount(); }
}
