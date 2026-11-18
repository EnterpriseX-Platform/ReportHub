package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.WarehousePipelineStep;

import java.util.List;

public interface WarehousePipelineStepRepository extends JpaRepository<WarehousePipelineStep, Long> {
    List<WarehousePipelineStep> findByPipelineIdOrderByStepNoAsc(Long pipelineId);
    void deleteByPipelineId(Long pipelineId);
}
