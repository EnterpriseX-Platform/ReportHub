package io.reporthub.reportstudio.render;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.gateway.JobLogAppender;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Statement;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Future;

/**
 * Makes "cancel job" actually stop the work instead of only relabelling the row.
 *
 * <p>Before this existed, {@code POST /jobs/{id}/cancel} flipped the job row to {@code error} and
 * nothing else: the render thread kept going and — worse — the Oracle query it was blocked on kept
 * running as long as it liked, holding a worker slot and a DB session. {@code Future.cancel(true)}
 * alone does not help, because JDBC {@code executeQuery()} ignores thread interrupts.
 *
 * <p>So we track, per job:
 * <ul>
 *   <li>the {@link Future} of the render task (to interrupt whatever IS interruptible), and</li>
 *   <li>every {@link Statement} opened against the report's datasource, via a {@link Connection}
 *       proxy — this is the part that matters, because {@code Statement.cancel()} tells the server
 *       to abandon the running query, which makes the blocked {@code executeQuery()} throw.</li>
 * </ul>
 *
 * <p>The connection proxy is what lets us reach the statements JasperReports opens internally
 * during {@code fillReport}: we never see those objects, but we do own the connection they come from.
 */
@Component
public class JobCancelRegistry {

    private static final Logger log = LoggerFactory.getLogger(JobCancelRegistry.class);

    private record Entry(java.util.concurrent.atomic.AtomicReference<Future<?>> future, Set<Statement> statements) {}

    private final Map<String, Entry> live = new ConcurrentHashMap<>();

    /**
     * Open a slot for the job. Must be called BEFORE the render task is submitted: the render thread
     * can reach {@link #track} within microseconds, and a connection opened before the slot exists
     * would never be tracked.
     */
    public void register(String jobId) {
        if (jobId == null) return;
        live.put(jobId, new Entry(new java.util.concurrent.atomic.AtomicReference<>(), ConcurrentHashMap.newKeySet()));
    }

    /** Attach the render task once it has been submitted. */
    public void attach(String jobId, Future<?> future) {
        if (jobId == null) return;
        Entry e = live.get(jobId);
        if (e != null) e.future().set(future);
    }

    /** Called by the worker when the render finished (any outcome) so nothing leaks. */
    public void done(String jobId) {
        if (jobId != null) live.remove(jobId);
    }

    /**
     * Cancel the running render for {@code jobId}: abandon its in-flight queries first, then
     * interrupt the thread. Returns true if there was something live to cancel.
     */
    public boolean cancel(String jobId) {
        Entry e = live.remove(jobId);
        if (e == null) return false;
        int aborted = 0;
        for (Statement st : e.statements()) {
            try {
                st.cancel();
                aborted++;
            } catch (Exception ex) {
                log.debug("Job {} — statement cancel failed (already finished?): {}", jobId, ex.toString());
            }
        }
        Future<?> f = e.future().get();
        if (f != null) f.cancel(true);
        log.info("Job {} cancelled — {} in-flight statement(s) aborted", jobId, aborted);
        return true;
    }

    /**
     * Wrap a datasource connection so every statement it creates is tracked for the job running on
     * this thread. Outside a job — or once the job is gone — the connection is returned untouched,
     * so nothing changes for non-render callers.
     *
     * <p>Statements are dropped as a set when the job ends ({@link #done}); we deliberately do not
     * proxy the statements themselves to untrack on close, because handing JasperReports a proxied
     * {@code PreparedStatement} risks breaking driver-specific casts for no real benefit — cancelling
     * an already-closed statement is a no-op we swallow anyway.
     *
     * @param queryTimeoutSeconds when &gt; 0, also applied to each created statement as a JDBC-level
     *                            ceiling; 0 leaves the driver default (no timeout).
     */
    public Connection track(Connection conn, int queryTimeoutSeconds) {
        String jobId = MDC.get(JobLogAppender.MDC_JOB_ID);
        if (jobId == null || conn == null) return conn;
        Entry entry = live.get(jobId);
        if (entry == null) return conn;

        return (Connection) Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[]{Connection.class},
                new TrackingHandler(conn, entry, queryTimeoutSeconds));
    }

    /** Adds every statement the connection hands out to the job's set. */
    private record TrackingHandler(Connection target, Entry entry, int queryTimeoutSeconds)
            implements InvocationHandler {

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            Object result;
            try {
                result = method.invoke(target, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            }
            String name = method.getName();
            if (result instanceof Statement st
                    && (name.startsWith("prepare") || name.equals("createStatement"))) {
                if (queryTimeoutSeconds > 0) {
                    try { st.setQueryTimeout(queryTimeoutSeconds); } catch (Exception ignore) { /* driver may refuse */ }
                }
                entry.statements().add(st);
            }
            return result;
        }
    }
}
