package io.reporthub.reportstudio.analytics;

import java.util.List;

/**
 * Pivot request: one or more row dimensions, exactly one column dimension (cols[0]),
 * and a single measure to aggregate (sum).
 *
 * Valid dimensions: region, category, channel, fiscalYear (or year alias).
 * Valid measures:   target, sales, profit.
 */
public record PivotRequest(
        List<String> rows,
        List<String> cols,
        String measure,
        java.util.Map<String, String> filters
) {}
