package io.reporthub.reportstudio.repo;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import io.reporthub.reportstudio.domain.Report;

import java.util.List;
import java.util.Optional;

public interface ReportRepository extends JpaRepository<Report, String> {

    Optional<Report> findByCode(String code);

    boolean existsByCode(String code);

    // NOTE: parameters are CAST AS string so PostgreSQL can type a NULL bind
    // (otherwise lower(?) resolves to lower(bytea) and the statement fails to plan).
    @Query("""
        SELECT r FROM Report r
        WHERE (CAST(:category AS string) IS NULL OR r.categoryId = :category)
          AND (CAST(:status   AS string) IS NULL OR r.status     = :status)
          AND (CAST(:engine   AS string) IS NULL OR r.engine     = :engine)
          AND (CAST(:datasource AS string) IS NULL OR r.datasourceId = :datasource)
          AND (CAST(:q AS string) IS NULL
               OR LOWER(r.name) LIKE LOWER(CONCAT('%', CAST(:q AS string), '%'))
               OR LOWER(r.code)   LIKE LOWER(CONCAT('%', CAST(:q AS string), '%')))
        """)
    Page<Report> search(@Param("category") String category,
                         @Param("status") String status,
                         @Param("engine") String engine,
                         @Param("datasource") String datasource,
                         @Param("q") String q,
                         Pageable pageable);

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

    List<Report> findTop8ByOrderByUpdatedAtDesc();

    interface CategoryCount { String getCategoryId(); long getCount(); }
    interface StatusCount   { String getStatus();     long getCount(); }
    interface EngineCount   { String getEngine();     long getCount(); }
}
