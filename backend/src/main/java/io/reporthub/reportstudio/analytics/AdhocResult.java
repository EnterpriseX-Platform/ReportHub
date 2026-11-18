package io.reporthub.reportstudio.analytics;

import java.util.List;
import java.util.Map;

/**
 * Ad-hoc query result. {@code columns} preserves the requested field order;
 * each row is a column-name -> value map (String for dimensions, Long for measures).
 * {@code totals} carries the grand-total sum for each measure column.
 */
public record AdhocResult(
        List<String> columns,
        List<Map<String, Object>> rows,
        Map<String, Long> totals,
        int rowCount
) {}
