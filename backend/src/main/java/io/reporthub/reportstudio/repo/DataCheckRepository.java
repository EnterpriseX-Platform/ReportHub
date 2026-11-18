package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.DataCheck;

import java.time.OffsetDateTime;
import java.util.List;

public interface DataCheckRepository extends JpaRepository<DataCheck, Long> {
    List<DataCheck> findAllByOrderByCreatedAtDesc();
    List<DataCheck> findByEnabledTrueAndCronIsNotNullAndNextRunAtLessThanEqual(OffsetDateTime now);

    /**
     * Stamp "last run at" on a single row without touching other columns.
     *
     * <p>Previously the run ended with {@code repo.save(c)} on the whole entity - {@code c}
     * was loaded <b>before</b> the SQL ran, which takes several seconds; if someone edited the check on screen meanwhile
     * (inline editing makes this more likely), the save overwrote the new values with old ones <b>silently</b>
     * - freshly edited SQL vanished with no error (the same lost-update pattern that once resurrected disabled schedules).
     *
     * <p>Only the columns owned by the run are updated, so it can no longer clash with user edits.
     */
    @Modifying
    @Transactional
    @Query("update DataCheck c set c.lastRunAt = :at where c.id = :id")
    int touchLastRun(@Param("id") Long id, @Param("at") OffsetDateTime at);

    /** Write only the run-result columns; 0 rows = the check was deleted while it ran (nothing resurrected). */
    @Modifying
    @Transactional
    @Query("update DataCheck c set c.lastStatus = :status, c.lastCount = :count, c.lastError = :error where c.id = :id")
    int saveRunResult(@Param("id") Long id, @Param("status") String status, @Param("count") Integer count,
                      @Param("error") String error);
}
