package io.reporthub.reportstudio.repo;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.WarehouseRun;

import java.util.List;

public interface WarehouseRunRepository extends JpaRepository<WarehouseRun, Long> {
    List<WarehouseRun> findByPipelineIdOrderByStartedAtDesc(Long pipelineId, Pageable pageable);
    /** Runs a chain currently has in progress — used when cancelling the whole chain to stop running steps too. */
    java.util.Optional<WarehouseRun> findFirstByTriggerAndStatusOrderByIdDesc(String trigger, String status);
    void deleteByPipelineId(Long pipelineId);
}
