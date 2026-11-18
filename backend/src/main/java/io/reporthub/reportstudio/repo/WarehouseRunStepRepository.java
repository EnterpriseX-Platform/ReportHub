package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.WarehouseRunStep;

import java.util.List;

public interface WarehouseRunStepRepository extends JpaRepository<WarehouseRunStep, Long> {
    List<WarehouseRunStep> findByRunIdOrderByStepNoAsc(Long runId);
    void deleteByRunId(Long runId);
}
