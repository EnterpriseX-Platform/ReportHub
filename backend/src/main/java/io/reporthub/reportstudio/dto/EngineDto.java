package io.reporthub.reportstudio.dto;

import java.time.OffsetDateTime;

/** An installed engine for the registry UI. The auth token is never returned — only whether one is set. */
public record EngineDto(
        Long id,
        String name,
        String kind,
        String installMethod,
        String baseUrl,
        String componentFormat,
        String artifactRef,
        boolean enabled,
        boolean hasToken,
        String note,
        OffsetDateTime createdAt
) {}
