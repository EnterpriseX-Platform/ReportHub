package io.reporthub.reportstudio.analytics;

import java.util.List;
import java.util.Map;

/**
 * Pivot result. Mirrors the client contract:
 * {colKeys:[], rows:[{label,depth,vals:{},rowTotal,isGroup}], colTotals:{}, grand}
 */
public record PivotResponse(
        List<String> colKeys,
        List<Row> rows,
        Map<String, Long> colTotals,
        long grand
) {
    public record Row(
            String label,
            int depth,
            Map<String, Long> vals,
            long rowTotal,
            boolean isGroup
    ) {}
}
