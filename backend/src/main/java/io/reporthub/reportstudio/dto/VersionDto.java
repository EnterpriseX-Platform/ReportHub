package io.reporthub.reportstudio.dto;

import java.time.OffsetDateTime;

/** One row of a report's version history. */
public record VersionDto(
        Long id,
        String version,
        String changeType,
        String note,
        String createdBy,
        OffsetDateTime createdAt,
        boolean current
) {}
