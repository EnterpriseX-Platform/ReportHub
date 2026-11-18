package io.reporthub.reportstudio.repo;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import io.reporthub.reportstudio.domain.EtlChainRun;

import java.util.List;

public interface EtlChainRunRepository extends JpaRepository<EtlChainRun, Long> {

    List<EtlChainRun> findByChainIdOrderByStartedAtDesc(Long chainId, Pageable page);

    /**
     * Highest round already used for this chain+year. A year that has never run returns null,
     * which the caller turns into round 1. NULL fiscal years are their own bucket — IS NOT
     * DISTINCT FROM would be cleaner but JPQL has no such operator.
     */
    @Query("""
           select max(r.roundNo) from EtlChainRun r
           where r.chainId = :chainId
             and ((:year is null and r.fiscalYear is null) or r.fiscalYear = :year)
           """)
    Integer maxRound(@Param("chainId") Long chainId, @Param("year") String year);
}
