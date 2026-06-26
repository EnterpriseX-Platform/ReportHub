package io.reporthub.reportstudio.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;

import java.util.List;

/** Payload for registering a new report (wizard or config import). */
public record CreateReportRequest(
        @NotBlank String code,
        @NotBlank String name,
        @NotBlank String categoryId,
        @NotBlank String engine,
        @NotEmpty List<String> formats,
        String datasourceId,
        String templatePath,
        String ownerUnit,
        Integer paramCount,
        String note
) {}
