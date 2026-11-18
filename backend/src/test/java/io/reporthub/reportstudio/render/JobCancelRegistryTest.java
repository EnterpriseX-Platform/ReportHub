package io.reporthub.reportstudio.render;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import io.reporthub.reportstudio.gateway.JobLogAppender;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class JobCancelRegistryTest {

    private static final String JOB = "J-1";

    private final JobCancelRegistry registry = new JobCancelRegistry();

    @AfterEach
    void clearMdc() {
        MDC.clear();
    }

    private void insideJob(String jobId) {
        MDC.put(JobLogAppender.MDC_JOB_ID, jobId);
    }

    @Test
    void cancelAbortsTheStatementTheRenderIsBlockedOn() throws Exception {
        insideJob(JOB);
        registry.register(JOB);
        registry.attach(JOB, new CompletableFuture<>());

        PreparedStatement st = mock(PreparedStatement.class);
        Connection raw = mock(Connection.class);
        when(raw.prepareStatement(anyString())).thenReturn(st);

        Connection tracked = registry.track(raw, 0);
        tracked.prepareStatement("SELECT 1 FROM DUAL");

        assertThat(registry.cancel(JOB)).isTrue();
        verify(st).cancel();
    }

    @Test
    void cancelInterruptsTheRenderTask() {
        insideJob(JOB);
        registry.register(JOB);
        CompletableFuture<Object> future = new CompletableFuture<>();
        registry.attach(JOB, future);

        registry.cancel(JOB);

        assertThat(future.isCancelled()).isTrue();
    }

    /** The render thread can open its connection before attach() runs — it must still be tracked. */
    @Test
    void tracksStatementsOpenedBeforeTheFutureIsAttached() throws Exception {
        insideJob(JOB);
        registry.register(JOB);

        PreparedStatement st = mock(PreparedStatement.class);
        Connection raw = mock(Connection.class);
        when(raw.prepareStatement(anyString())).thenReturn(st);
        registry.track(raw, 0).prepareStatement("SELECT 1 FROM DUAL");

        registry.attach(JOB, new CompletableFuture<>());

        assertThat(registry.cancel(JOB)).isTrue();
        verify(st).cancel();
    }

    @Test
    void appliesTheQueryTimeoutWhenConfigured() throws Exception {
        insideJob(JOB);
        registry.register(JOB);

        PreparedStatement st = mock(PreparedStatement.class);
        Connection raw = mock(Connection.class);
        when(raw.prepareStatement(anyString())).thenReturn(st);

        registry.track(raw, 90).prepareStatement("SELECT 1 FROM DUAL");

        verify(st).setQueryTimeout(90);
    }

    @Test
    void leavesTheStatementAloneWhenNoTimeoutIsConfigured() throws Exception {
        insideJob(JOB);
        registry.register(JOB);

        PreparedStatement st = mock(PreparedStatement.class);
        Connection raw = mock(Connection.class);
        when(raw.prepareStatement(anyString())).thenReturn(st);

        registry.track(raw, 0).prepareStatement("SELECT 1 FROM DUAL");

        verify(st, never()).setQueryTimeout(anyInt());
    }

    @Test
    void outsideAJobTheConnectionIsHandedBackUntouched() {
        Connection raw = mock(Connection.class);
        assertThat(registry.track(raw, 0)).isSameAs(raw);
    }

    @Test
    void anUnregisteredJobHasNothingToCancel() {
        assertThat(registry.cancel("J-nope")).isFalse();
    }

    @Test
    void doneReleasesTheSlotSoALateCancelIsANoOp() {
        insideJob(JOB);
        registry.register(JOB);
        registry.attach(JOB, new CompletableFuture<>());

        registry.done(JOB);

        assertThat(registry.cancel(JOB)).isFalse();
    }
}
