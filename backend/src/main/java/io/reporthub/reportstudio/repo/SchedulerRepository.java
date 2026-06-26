package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.Scheduler;

import java.time.OffsetDateTime;
import java.util.List;

public interface SchedulerRepository extends JpaRepository<Scheduler, Long> {
    List<Scheduler> findAllByOrderByCreatedAtDesc();
    List<Scheduler> findByEnabledTrueAndNextRunAtLessThanEqual(OffsetDateTime now);
}
