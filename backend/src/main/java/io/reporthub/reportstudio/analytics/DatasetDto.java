package io.reporthub.reportstudio.analytics;

import java.util.List;

/**
 * Ad-hoc dataset descriptor returned by GET /adhoc/datasets. Lists the dimension
 * and measure fields the client may pick, plus the distinct values available for
 * each filterable dimension.
 */
public record DatasetDto(
        String id,
        String name,
        List<FieldDto> dimensions,
        List<FieldDto> measures,
        FilterOptions filterOptions
) {
    public record FieldDto(String key, String label) {}

    public record FilterOptions(
            List<String> fiscalYears,
            List<String> regions,
            List<String> categories,
            List<String> channels
    ) {}
}
