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
        String note
) {}
