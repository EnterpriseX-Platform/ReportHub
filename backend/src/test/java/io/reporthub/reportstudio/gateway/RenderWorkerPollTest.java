package io.reporthub.reportstudio.gateway;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import io.reporthub.reportstudio.repo.JobRepository;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** The poller claims only as many jobs as there are free render slots, and stops claiming on shutdown. */
class RenderWorkerPollTest {

    private final JobRepository jobs = mock(JobRepository.class);
    private final JobQueue queue = mock(JobQueue.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private RenderWorker worker;

    private RenderWorker worker(int concurrency) {
        RenderWorker w = new RenderWorker(
                jobs, null, null, null, mapper, null, null, null, null, null, null, queue);
        ReflectionTestUtils.setField(w, "concurrency", concurrency);
        ReflectionTestUtils.setField(w, "renderTimeoutMinutes", 1L);
        w.initDispatch();
        worker = w;
        return w;
    }

    @AfterEach
    void tearDown() {
        if (worker != null) worker.drainBeforeShutdown();
    }

    @Test
    void claimsUpToTheConfiguredConcurrency() {
        when(queue.claim(anyString(), anyInt())).thenReturn(List.of());

        worker(3).pollQueue();

        verify(queue).claim(anyString(), eq(3));
    }

    @Test
    void doesNotClaimWhenEverySlotIsBusy() {
        RenderWorker w = worker(2);
        @SuppressWarnings("unchecked")
        java.util.Set<String> inFlight = (java.util.Set<String>) ReflectionTestUtils.getField(w, "inFlight");
        inFlight.add("a");
        inFlight.add("b");

        w.pollQueue();

        verify(queue, never()).claim(anyString(), anyInt());
    }

    @Test
    void stopsClaimingOnceShutdownBegins() {
        RenderWorker w = worker(2);
        w.drainBeforeShutdown();

        w.pollQueue();

        verify(queue, never()).claim(anyString(), anyInt());
    }

    @Test
    void rebuildsTheEnvelopeFromThePayloadAndTheClaimedToken() throws Exception {
        RenderWorker w = worker(1);
        String payload = mapper.writeValueAsString(new JobMessage(
                "j1", "RPT-01", "Report", "jasper", "PDF", Map.of("YEAR", 2026), null, "ds1", "alice", null));

        JobMessage msg = w.toMessage(new JobQueue.ClaimedJob("j1", payload, "tok"));

        assertThat(msg.reportCode()).isEqualTo("RPT-01");
        assertThat(msg.params()).containsEntry("YEAR", 2026);
        assertThat(msg.requestedBy()).isEqualTo("alice");
        assertThat(msg.callerToken()).isEqualTo("tok");
    }

    @Test
    void claimQueryNeverBlocksOnRowsAnotherWorkerHolds() {
        assertThat(JobQueue.CLAIM_SQL)
                .contains("FOR UPDATE SKIP LOCKED")
                .contains("WHERE state = 'queued'")
                .contains("caller_token = NULL")
                .contains("RETURNING");
    }
}
