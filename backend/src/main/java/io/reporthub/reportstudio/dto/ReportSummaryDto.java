package io.reporthub.reportstudio.dto;

import java.time.OffsetDateTime;
import java.util.List;

/** Report row for the registry table / dashboard lists. */
public record ReportSummaryDto(
        String id,
        String code,
        String name,
        String categoryId,
        String categoryRef,
        String engine,
        List<String> formats,
        String status,
        String datasourceId,
        String datasourceName,
        String version,
        int avgMs,
        int runs,
        OffsetDateTime updatedAt
) {}
