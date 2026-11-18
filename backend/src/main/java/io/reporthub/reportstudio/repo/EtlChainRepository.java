package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.EtlChain;

import java.util.List;

public interface EtlChainRepository extends JpaRepository<EtlChain, Long> {
    List<EtlChain> findAllByOrderByFolderAscNameAsc();
}
