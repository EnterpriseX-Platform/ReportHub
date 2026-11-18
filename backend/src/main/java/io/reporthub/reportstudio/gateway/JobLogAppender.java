package io.reporthub.reportstudio.gateway;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import ch.qos.logback.core.AppenderBase;
import jakarta.annotation.PostConstruct;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Captures everything logged during a single render job — correlated by the MDC key {@code jobId} —
 * into a bounded in-memory ring buffer, so the Queue Monitor can download/copy the REAL run log of a
 * failed job instead of forcing an operator into the cluster.
 *
 * <p>{@link RenderWorker} calls {@link #begin} when a job starts and {@link #drain} when it ends
 * (persisting the text only on failure). Buffers are per-job and always drained in a {@code finally},
 * so memory is bounded by roughly (render concurrency × {@link #MAX_LINES}). The appender is attached
 * to the ROOT logger at startup so it sees app + Jasper + JDBC logs alike.
 */
@Component
public class JobLogAppender extends AppenderBase<ILoggingEvent> {

    public static final String MDC_JOB_ID = "jobId";
    private static final int MAX_LINES = 1000;
    private static final int MAX_CHARS = 256 * 1024;
    private static final DateTimeFormatter TS =
            DateTimeFormatter.ofPattern("HH:mm:ss.SSS").withZone(ZoneId.systemDefault());

    /** A per-job ring buffer with a running char count, so we can cap by both line and byte size. */
    private static final class Buf {
        final Deque<String> lines = new ArrayDeque<>();
        int chars = 0;
    }

    private final Map<String, Buf> buffers = new ConcurrentHashMap<>();

    @PostConstruct
    void register() {
        LoggerContext lc = (LoggerContext) LoggerFactory.getILoggerFactory();
        setContext(lc);
        start();
        ((Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME)).addAppender(this);
    }

    /** Start capturing logs emitted (on any thread) under MDC {@code jobId == jobId}. */
    public void begin(String jobId) {
        if (jobId != null) buffers.put(jobId, new Buf());
    }

    /** Stop capturing and return the captured text, or {@code null} if nothing was captured. */
    public String drain(String jobId) {
        if (jobId == null) return null;
        Buf buf = buffers.remove(jobId);
        if (buf == null) return null;
        synchronized (buf) {
            return buf.lines.isEmpty() ? null : String.join("\n", buf.lines);
        }
    }

    @Override
    protected void append(ILoggingEvent e) {
        String jobId = e.getMDCPropertyMap().get(MDC_JOB_ID);
        if (jobId == null) return;
        Buf buf = buffers.get(jobId);
        if (buf == null) return;

        StringBuilder sb = new StringBuilder(160);
        sb.append(TS.format(Instant.ofEpochMilli(e.getTimeStamp())))
                .append(' ').append(e.getLevel()).append(' ')
                .append(shortLogger(e.getLoggerName())).append(" - ")
                .append(e.getFormattedMessage());
        if (e.getThrowableProxy() != null) {
            sb.append('\n').append(ThrowableProxyUtil.asString(e.getThrowableProxy()));
        }
        String line = sb.toString();

        synchronized (buf) {
            buf.lines.addLast(line);
            buf.chars += line.length();
            while (buf.lines.size() > MAX_LINES || buf.chars > MAX_CHARS) {
                String removed = buf.lines.pollFirst();
                if (removed == null) break;
                buf.chars -= removed.length();
            }
        }
    }

    private static String shortLogger(String name) {
        if (name == null) return "";
        int i = name.lastIndexOf('.');
        return i < 0 ? name : name.substring(i + 1);
    }
}
