package io.reporthub.reportstudio.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

import java.util.List;

/** Create/update payload for a parameter definition. */
public record SaveParamRequest(
        @NotBlank @Pattern(regexp = "[A-Za-z][A-Za-z0-9_]*", message = "name must be an identifier")
        String name,
        @NotBlank String label,
        @NotBlank String type,
        boolean required,
        String defaultValue,
        @NotBlank String sourceType,
        List<ParamOptionDto> staticOptions,
        String lookupTable,
        String sourceSql,
        String datasourceId,
        String valueColumn,
        String labelColumn,
        String dependsOn,
        String filterColumn,
        Integer sortOrder
) {}
