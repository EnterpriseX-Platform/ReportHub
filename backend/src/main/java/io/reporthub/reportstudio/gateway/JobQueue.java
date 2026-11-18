package io.reporthub.reportstudio.gateway;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.List;

/**
 * Postgres-backed render queue. The {@code job} table IS the queue:
 *
 * <ul>
 *   <li><b>enqueue</b> — {@link JobGateway} commits a row in state {@code queued} (nothing else is sent);</li>
 *   <li><b>claim</b> — {@link #claim} atomically flips up to {@code limit} queued rows to {@code running}
 *       using {@code FOR UPDATE SKIP LOCKED}, so any number of worker pods can poll concurrently and
 *       each job is handed to exactly one of them;</li>
 *   <li><b>liveness</b> — the owning worker bumps {@code heartbeat_at} via {@link #heartbeat} while it renders.</li>
 * </ul>
 *
 * <p>The caller token is returned by the claim and cleared in the same statement, so it never outlives
 * the queue (the CTE reads the pre-update value).
 */
@Component
public class JobQueue {

    /** Highest priority first, then oldest first (started_at is the enqueue time). */
    static final String CLAIM_SQL = """
            WITH c AS (
                SELECT id, caller_token
                  FROM job
                 WHERE state = 'queued'
                 ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, started_at
                 LIMIT ?
                 FOR UPDATE SKIP LOCKED
            )
            UPDATE job j
               SET state = 'running', stage = 'worker', progress = 10,
                   claimed_by = ?, claimed_at = now(), heartbeat_at = now(), caller_token = NULL
              FROM c
             WHERE j.id = c.id
            RETURNING j.id, j.payload, c.caller_token
            """;

    static final String HEARTBEAT_SQL =
            "UPDATE job SET heartbeat_at = now() WHERE state = 'running' AND claimed_by = ? AND id = ANY (?)";

    private final JdbcTemplate jdbc;

    public JobQueue(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** A job this worker now owns. {@code payload} may be null for rows enqueued before V63. */
    public record ClaimedJob(String id, String payload, String callerToken) {}

    /** Claim up to {@code limit} queued jobs for {@code workerId}. Never blocks on rows another worker holds. */
    public List<ClaimedJob> claim(String workerId, int limit) {
        if (limit <= 0) return List.of();
        return jdbc.query(CLAIM_SQL,
                (rs, i) -> new ClaimedJob(rs.getString(1), rs.getString(2), rs.getString(3)),
                limit, workerId);
    }

    /** Refresh the heartbeat of the jobs this worker is rendering. */
    public void heartbeat(String workerId, Collection<String> jobIds) {
        if (jobIds.isEmpty()) return;
        jdbc.update(con -> {
            var ps = con.prepareStatement(HEARTBEAT_SQL);
            ps.setString(1, workerId);
            ps.setArray(2, con.createArrayOf("varchar", jobIds.toArray()));
            return ps;
        });
    }
}
