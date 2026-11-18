package io.reporthub.reportstudio.gateway;

import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import io.reporthub.reportstudio.domain.Job;
import io.reporthub.reportstudio.repo.JobRepository;

import java.time.OffsetDateTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * A pod that dies mid-render leaves its job row saying "running" forever — nothing is left alive to
 * write the terminal state. These rows pile up in the Queue Monitor and look like live work.
 * Live workers heartbeat their jobs, so only rows whose heartbeat went stale are failed.
 */
class RenderWorkerOrphanRecoveryTest {

    private final JobRepository jobs = mock(JobRepository.class);

    private RenderWorker worker() {
        RenderWorker w = new RenderWorker(
                jobs, null, null, null, null, null, null, null, null, null, null, null);
        ReflectionTestUtils.setField(w, "renderTimeoutMinutes", 20L);
        ReflectionTestUtils.setField(w, "staleAfterMs", 120_000L);
        return w;
    }

    private static Job job(String id, String state) {
        Job j = new Job();
        j.setId(id);
        j.setState(state);
        j.setReportCode("SALES-204");
        j.setStartedAt(OffsetDateTime.now().minusMinutes(5));
        return j;
    }

    @Test
    void failsRunningJobWhoseHeartbeatWentStale() {
        Job orphan = job("J-1", "running");
        orphan.setHeartbeatAt(OffsetDateTime.now().minusMinutes(10));
        when(jobs.findByState("running")).thenReturn(List.of(orphan));

        worker().failOrphanedRunningJobs();

        assertThat(orphan.getState()).isEqualTo("error");
        assertThat(orphan.getErrorMessage()).contains("Worker restarted");
        verify(jobs).save(orphan);
    }

    @Test
    void leavesRunningJobWithFreshHeartbeatAlone() {
        // e.g. a sibling worker pod still rendering it during a rolling update
        Job live = job("J-2", "running");
        live.setHeartbeatAt(OffsetDateTime.now().minusSeconds(10));
        when(jobs.findByState("running")).thenReturn(List.of(live));

        worker().failOrphanedRunningJobs();

        assertThat(live.getState()).isEqualTo("running");
        verify(jobs, never()).save(any());
    }

    @Test
    void legacyRowWithoutHeartbeatFallsBackToTheJobTimeLimit() {
        Job young = job("J-3", "running");                          // 5 min old, within the 20 min limit
        Job old = job("J-4", "running");
        old.setStartedAt(OffsetDateTime.now().minusHours(3));
        when(jobs.findByState("running")).thenReturn(List.of(young, old));

        worker().failOrphanedRunningJobs();

        assertThat(young.getState()).isEqualTo("running");
        assertThat(old.getState()).isEqualTo("error");
        verify(jobs).save(old);
        verify(jobs, never()).save(young);
    }

    @Test
    void onlyLooksAtRunningJobs() {
        when(jobs.findByState("running")).thenReturn(List.of());

        worker().failOrphanedRunningJobs();

        verify(jobs).findByState("running");
        verify(jobs, never()).findAll();
        verify(jobs, never()).save(any());
    }
}
