package io.reporthub.reportstudio.dto;

import java.util.List;
import java.util.Map;

/** Aggregated dashboard payload: headline stats + breakdowns + recent reports. */
public record DashboardSummaryDto(
        Stats stats,
        List<CategoryDto> categories,
        Map<String, Long> statusBreakdown,
        Map<String, Long> engineBreakdown,
        List<ReportSummaryDto> recentReports
) {
    public record Stats(
            long registered,
            int required,
            int datasources,
            // operational figures (mocked until the gateway is wired)
            int runsToday,
            int inQueue,
            int avgRenderMs,
            double successRate,
            int failedToday
    ) {}
}
