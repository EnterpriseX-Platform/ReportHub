package io.reporthub.reportstudio.analytics;

import java.util.List;
import java.util.Map;

/**
 * Ad-hoc query request.
 *
 * @param dataset dataset id (currently only "fact")
 * @param fields  picked output columns — a mix of dimensions
 *                (region, category, channel, fiscalYear) and measures
 *                (target, sales, profit). Dimension fields become GROUP BY keys;
 *                measure fields become SUM aggregates.
 * @param filters equality filters keyed by dimension name, e.g.
 *                {"fiscalYear":"2025","region":"North"}. Empty / null = no filter.
 */
public record AdhocRequest(
        String dataset,
        List<String> fields,
        Map<String, String> filters
) {}
