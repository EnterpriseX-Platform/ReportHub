package io.reporthub.reportstudio.repo;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.DataCheckRun;

import java.util.List;

public interface DataCheckRunRepository extends JpaRepository<DataCheckRun, Long> {
    List<DataCheckRun> findByCheckIdOrderByStartedAtDesc(Long checkId, Pageable pageable);
    /** Latest run of this check - used to fetch the "failing rows" stored at run time instead of re-querying. */
    java.util.Optional<DataCheckRun> findFirstByCheckIdOrderByStartedAtDesc(Long checkId);
    void deleteByCheckId(Long checkId);

    /** All rows of one round - shows the result of each check in that round. */
    List<DataCheckRun> findByBatchId(String batchId);

    /**
     * Round summaries for one check group, newest first - one row per round.
     *
     * <p>Runs without a round number (single runs, scheduler runs, runs older than this column) are not counted,
     * otherwise the history would fill with single-check "rounds".
     */
    @org.springframework.data.jpa.repository.Query("""
            select r.batchId, min(r.startedAt), max(r.finishedAt), count(r),
                   sum(case when r.status = 'pass' then 1 else 0 end),
                   sum(case when r.status in ('fail','error') then 1 else 0 end),
                   min(r.runBy)
              from DataCheckRun r
             where r.batchId is not null and r.checkId in :checkIds
             group by r.batchId
             order by min(r.startedAt) desc
            """)
    List<Object[]> summariseRounds(@org.springframework.data.repository.query.Param("checkIds") List<Long> checkIds,
                                   Pageable pageable);
}
