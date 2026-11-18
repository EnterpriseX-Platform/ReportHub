package io.reporthub.reportstudio.service;

import java.time.OffsetDateTime;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import io.reporthub.reportstudio.web.BadRequestException;

/**
 * Shared queue for interactive queries a user waits on — preview, the SQL box, screen results.
 *
 * <p>Why: the app sits behind a CDN that drops requests idle for more than ~50 seconds and returns its own
 * "520" HTML page, so the user cannot tell a failed query from a slow one, and heavy queries (minutes long)
 * can never succeed that way.
 *
 * <p>Rule: <b>every command is queued — there is no synchronous shortcut</b>. The caller submits work, gets
 * a job id back immediately, then polls for status, just like pipelines and report jobs already do
 * (so nobody has to decide which calls should wait and which should not).
 */
@Service
public class QueryQueueService {

    private static final Logger log = LoggerFactory.getLogger(QueryQueueService.class);

    /** How long finished results stay pollable — enough for screens polling every 1-2 seconds. */
    private static final long KEEP_FINISHED_MINUTES = 15;
    /** Stops long-stuck queries from holding database connections indefinitely. */
    private static final long ABANDON_AFTER_MINUTES = 30;

    public record Job(String id, String status, Object result, String error,
                      OffsetDateTime startedAt, OffsetDateTime finishedAt, Long ms) {}

    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService pool;

    public QueryQueueService() {
        AtomicInteger n = new AtomicInteger();
        ThreadFactory tf = r -> {
            Thread t = new Thread(r, "query-queue-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
        // Screen queries mostly wait on the database, not CPU — but cap them so connections are not left open
        this.pool = Executors.newFixedThreadPool(8, tf);
    }

    /** Queues the work and returns the job id immediately without waiting. */
    public String submit(Supplier<Object> work) {
        String id = UUID.randomUUID().toString();
        OffsetDateTime t0 = OffsetDateTime.now();
        jobs.put(id, new Job(id, "running", null, null, t0, null, null));
        pool.submit(() -> {
            long n0 = System.nanoTime();
            try {
                Object r = work.get();
                jobs.put(id, new Job(id, "ok", r, null, t0, OffsetDateTime.now(), ms(n0)));
            } catch (RuntimeException e) {
                // BadRequestException messages are already human-readable (via WarehouseService.friendly)
                String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                jobs.put(id, new Job(id, "error", null, msg, t0, OffsetDateTime.now(), ms(n0)));
            }
        });
        return id;
    }

    /** Status/result of a job — an unknown job (expired or wrong id) is reported clearly, never as a stuck "running". */
    public Job get(String id) {
        Job j = jobs.get(id);
        if (j == null) {
            throw new BadRequestException("Query job not found — it may have expired (results are kept "
                    + KEEP_FINISHED_MINUTES + " minutes after finishing). Run it again.");
        }
        return j;
    }

    private static long ms(long n0) {
        return Math.round((System.nanoTime() - n0) / 1_000_000.0);
    }

    /** Sweeps old jobs — otherwise large query results would stay in memory indefinitely. */
    @Scheduled(fixedDelay = 60_000, initialDelay = 60_000)
    public void sweep() {
        OffsetDateTime now = OffsetDateTime.now();
        int removed = 0;
        for (Job j : jobs.values()) {
            boolean done = j.finishedAt() != null;
            boolean stale = done
                    ? j.finishedAt().isBefore(now.minusMinutes(KEEP_FINISHED_MINUTES))
                    : j.startedAt().isBefore(now.minusMinutes(ABANDON_AFTER_MINUTES));
            if (stale && jobs.remove(j.id()) != null) removed++;
        }
        if (removed > 0) log.debug("Query queue: cleared {} finished/abandoned job(s)", removed);
    }
}
