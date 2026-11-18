package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.EtlChainRunStep;

import java.util.List;

public interface EtlChainRunStepRepository extends JpaRepository<EtlChainRunStep, Long> {
    List<EtlChainRunStep> findByRunIdOrderByStepNoAsc(Long runId);
}
