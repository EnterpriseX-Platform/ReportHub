package io.reporthub.reportstudio.dto;

import java.util.List;

/**
 * Config-screen update for a report. Null fields are left unchanged.
 * Saving bumps the minor version and appends a {@code report_version} entry.
 */
public record UpdateReportRequest(
        String name,
        String categoryId,
        String engine,
        List<String> formats,
        String status,
        String datasourceId,
        String templatePath,
        String ownerUnit,
        String configJson,
        String outputFolder,
        Boolean testData,
        /** CSV of role codes that may see this report from the portal; "" = everyone. */
        String allowedRoles,
        String note,
        /** high | normal | low (default normal). */
        String priority,
        /** Render time limit in minutes (1-1440); null = global limit. */
        Integer timeoutMinutes,
        /** Queue label. */
        String queue
) {}
