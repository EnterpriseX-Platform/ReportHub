package io.reporthub.reportstudio.dto;

import java.util.Map;

/** Queue Monitor headline figures + pipeline stage counts. */
public record QueueStatsDto(
        long active,
        long completedLastHour,
        int avgWaitMs,
        int consumerLag,
        Map<String, Long> pipeline   // ingress / queue / worker / jasper / store (active jobs)
) {}
