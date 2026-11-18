package io.reporthub.reportstudio.dto;

import java.util.List;

/** Parameter definition + (for static sources) its inline options. */
public record ParamDefDto(
        Long id,
        String name,
        String label,
        String type,
        boolean required,
        String defaultValue,
        String sourceType,
        List<ParamOptionDto> staticOptions,
        String lookupTable,
        String sourceSql,
        String datasourceId,
        String valueColumn,
        String labelColumn,
        String dependsOn,
        String filterColumn,
        int sortOrder,
        long usedByReports,
        /** Per-report required override when this DTO is returned for a specific report (else null). */
        Boolean requiredOverride
) {}
