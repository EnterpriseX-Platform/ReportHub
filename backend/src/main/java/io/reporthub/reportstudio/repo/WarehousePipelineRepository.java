package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.WarehousePipeline;

import java.time.OffsetDateTime;
import java.util.List;

public interface WarehousePipelineRepository extends JpaRepository<WarehousePipeline, Long> {
    List<WarehousePipeline> findAllByOrderByCreatedAtDesc();
    List<WarehousePipeline> findByEnabledTrueAndCronIsNotNullAndNextRunAtLessThanEqual(OffsetDateTime now);
}
