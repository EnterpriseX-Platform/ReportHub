package io.reporthub.reportstudio.engine.builtin;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.repo.JobRepository;

/**
 * Writes progress of a "book" job to its job row while the engine is still rendering the children.
 *
 * <p>Must be {@code REQUIRES_NEW} - {@code EngineResolver.render()} is
 * {@code @Transactional(readOnly = true)}, so Hibernate sets FlushMode.MANUAL on that session.
 * Joining the existing transaction would merge into the persistence context and **never flush,
 * with no error or warning** - progress silently lost. A new transaction suspends the outer one
 * and borrows one extra connection briefly (returned on commit).
 *
 * <p>Updates {@code progress} only - never {@code stage}, because the Queue screen maps stage to text
 * from a fixed list and an unknown value would show as a dash ({@code frontend/src/app/queue/page.tsx})
 */
@Component
public class BookProgress {

    private final JobRepository jobs;

    public BookProgress(JobRepository jobs) {
        this.jobs = jobs;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void set(String jobId, int progress) {
        if (jobId == null || jobId.isBlank()) return;
        jobs.findById(jobId).ifPresent(j -> {
            j.setProgress(Math.max(0, Math.min(100, progress)));
            jobs.save(j);
        });
    }
}
