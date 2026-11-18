package io.reporthub.reportstudio.dto;

import java.util.List;
import java.util.Map;

/** Queue Monitor headline figures + pipeline stage counts + live partition/worker state. */
public record QueueStatsDto(
        long active,
        long completedLastHour,
        int avgWaitMs,
        int consumerLag,              // jobs queued and not yet claimed by a worker
        Map<String, Long> pipeline,   // ingress / queue / worker / jasper / store (active jobs)
        int workerConcurrency,        // configured render-pool size (app.render.concurrency)
        int workersActive,            // jobs rendering right now
        int workersQueued,            // jobs waiting for a free worker
        List<PartitionStat> partitions, // queue partitions + backlog; the Postgres queue is a single partition 0
        long failedLastHour,          // state=error, started in the last hour
        long cancelledLastHour        // state=cancelled (stopped by a user), counted apart from failures
) {
    /** One queue partition and its backlog (jobs waiting to be claimed). */
    public record PartitionStat(int partition, long lag) {}
}
