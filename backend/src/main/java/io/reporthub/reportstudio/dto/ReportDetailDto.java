package io.reporthub.reportstudio.dto;

import java.time.OffsetDateTime;
import java.util.List;

/** Full report definition for the detail view. */
public record ReportDetailDto(
        String id,
        String code,
        String name,
        String categoryId,
        String categoryRef,
        String categoryName,
        String engine,
        List<String> formats,
        String status,
        String datasourceId,
        String datasourceName,
        String templatePath,
        String version,
        String ownerUnit,
        int avgMs,
        int runs,
        int paramCount,
        String configJson,
        String outputFolder,
        OffsetDateTime updatedAt
) {}
