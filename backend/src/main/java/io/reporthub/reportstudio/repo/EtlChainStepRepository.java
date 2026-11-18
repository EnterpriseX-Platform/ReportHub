package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.EtlChainStep;

import java.util.List;

public interface EtlChainStepRepository extends JpaRepository<EtlChainStep, Long> {
    List<EtlChainStep> findByChainIdOrderByStepNoAsc(Long chainId);
    void deleteByChainId(Long chainId);
    List<EtlChainStep> findByPipelineId(Long pipelineId);
    List<EtlChainStep> findByCheckId(Long checkId);
    List<EtlChainStep> findBySchedulerId(Long schedulerId);
}
