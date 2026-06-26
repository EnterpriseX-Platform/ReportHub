package io.reporthub.reportstudio.dto;

import java.time.OffsetDateTime;

public record JobDto(
        String id,
        String reportCode,
        String reportName,
        String stage,
        String state,
        String fmt,
        String datasourceId,
        String requestedBy,
        OffsetDateTime startedAt,
        int progress,
        int partition,
        String priority,
        String errorMessage
) {}
