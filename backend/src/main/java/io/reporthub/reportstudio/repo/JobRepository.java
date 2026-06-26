package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import io.reporthub.reportstudio.domain.Job;

import java.util.List;

public interface JobRepository extends JpaRepository<Job, String> {

    List<Job> findAllByOrderByStartedAtDesc();

    long countByState(String state);

    long countByStateAndStartedAtAfter(String state, java.time.OffsetDateTime after);
    long countByStartedAtAfter(java.time.OffsetDateTime after);

    @Query("SELECT j.stage AS stage, COUNT(j) AS count FROM Job j WHERE j.state IN ('queued','running') GROUP BY j.stage")
    List<StageCount> countActiveByStage();

    interface StageCount { String getStage(); long getCount(); }
}
