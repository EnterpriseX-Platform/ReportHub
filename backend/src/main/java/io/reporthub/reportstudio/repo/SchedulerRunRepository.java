package io.reporthub.reportstudio.repo;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.SchedulerRun;

import java.util.List;

public interface SchedulerRunRepository extends JpaRepository<SchedulerRun, Long> {
    List<SchedulerRun> findBySchedulerIdOrderByStartedAtDesc(Long schedulerId, Pageable pageable);
    void deleteBySchedulerId(Long schedulerId);
}
