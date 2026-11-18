package io.reporthub.reportstudio.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Statement;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Cancellation registry for warehouse load runs — parallel to {@code render/JobCancelRegistry} but keyed
 * by run id rather than MDC, because loads run on a single worker not tied to a per-request log context.
 *
 * <p>Why cancel at the {@link Statement} level: a load step once sat in {@code free buffer waits} for
 * 45 minutes. Stopping the Java thread does nothing — the Oracle session keeps running the INSERT until
 * someone kills the session on the database. {@code Statement.cancel()} is the only way the app can stop
 * the work inside the database itself (supported by ojdbc).
 *
 * <p>Same assumption as RenderWorker: a single API replica, so an in-process registry covers all runs.
 */
@Component
public class WarehouseCancelRegistry {

    private static final Logger log = LoggerFactory.getLogger(WarehouseCancelRegistry.class);

    private record Entry(Set<Statement> statements, AtomicBoolean cancelled) {
        Entry() { this(ConcurrentHashMap.newKeySet(), new AtomicBoolean(false)); }
    }

    private final Map<Long, Entry> live = new ConcurrentHashMap<>();

    /** Called by the worker before loading — keeps the cancelled flag if a cancel arrived first (covers the start-up gap). */
    public void register(Long runId) {
        live.computeIfAbsent(runId, k -> new Entry());
    }

    /** Called by the worker when the run ends, in every case, so the registry does not leak. */
    public void done(Long runId) {
        live.remove(runId);
    }

    /** Whether a cancel was requested — lets the worker tell "failed" apart from "stopped by a user". */
    public boolean wasCancelled(Long runId) {
        Entry e = live.get(runId);
        return e != null && e.cancelled().get();
    }

    /**
     * Requests cancellation: always sets the flag first (a run that has not created a statement yet sees
     * it at register/track), then cancels any running statements.
     *
     * @return true when the run was already registered before this call — i.e. the worker picked it up
     *         (not the number of statements aborted: the gap between two statements still counts as running).
     *         false = still queued / not on this instance — the caller must close the row itself.
     */
    public boolean cancel(Long runId) {
        boolean wasLive = live.containsKey(runId);
        Entry e = live.computeIfAbsent(runId, k -> new Entry());
        e.cancelled().set(true);
        int aborted = 0;
        for (Statement st : e.statements()) {
            try {
                st.cancel();
                aborted++;
            } catch (Exception ex) {
                log.debug("run {} — statement cancel failed (may have finished already): {}", runId, ex.toString());
            }
        }
        if (wasLive) log.info("run {} cancelled — aborted {} running statement(s)", runId, aborted);
        return wasLive;
    }

    /**
     * Wraps the connection so every statement it hands out is registered for this run — one place covering
     * every command (source SELECT / INSERT..SELECT / TRUNCATE PARTITION) without touching each call site.
     * If the cancel flag is already set, a new statement is cancelled as soon as it is created.
     */
    public Connection track(Long runId, Connection conn) {
        if (runId == null || conn == null) return conn;
        Entry entry = live.get(runId);
        if (entry == null) return conn;
        return (Connection) Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[]{Connection.class},
                new TrackingHandler(conn, entry));
    }

    private record TrackingHandler(Connection target, Entry entry) implements InvocationHandler {
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
                entry.statements().add(st);
                if (entry.cancelled().get()) {
                    // cancel() on a statement that has not started executing is a no-op — the next
                    // command would just run, so close it and throw to fail the load path here.
                    try { st.close(); } catch (Exception ignore) { /* about to throw anyway */ }
                    throw new java.sql.SQLException("Run cancelled by user");
                }
            }
            return result;
        }
    }
}
