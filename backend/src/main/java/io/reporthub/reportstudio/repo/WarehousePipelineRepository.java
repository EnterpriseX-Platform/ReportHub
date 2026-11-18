package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.WarehousePipeline;

import java.time.OffsetDateTime;
import java.util.List;

public interface WarehousePipelineRepository extends JpaRepository<WarehousePipeline, Long> {
    List<WarehousePipeline> findAllByOrderByCreatedAtDesc();
    List<WarehousePipeline> findByEnabledTrueAndCronIsNotNullAndNextRunAtLessThanEqual(OffsetDateTime now);
    long countBySourceDatasourceIdOrTargetDatasourceId(String sourceDatasourceId, String targetDatasourceId);

    /**
     * Stamps run results onto the row without touching user-owned fields (name, SQL, target, cron).
     *
     * <p>Same reason as {@code DataCheckRepository.touchLastRun}: previously the whole entity was saved after
     * the run, but it had been read before a pipeline that can take minutes. If someone edited it meanwhile,
     * their SQL/name/target changes were silently overwritten with the old values.
     */
    @Modifying
    @Transactional
    @Query("update WarehousePipeline p set p.lastRunAt = :at, p.lastStatus = :status, "
         + "p.lastError = :error, p.lastRowsRead = :read, p.lastRowsWritten = :written "
         + "where p.id = :id")
    int touchLastRun(@Param("id") Long id, @Param("at") OffsetDateTime at,
                     @Param("status") String status, @Param("error") String error,
                     @Param("read") Integer read, @Param("written") Integer written);
}
