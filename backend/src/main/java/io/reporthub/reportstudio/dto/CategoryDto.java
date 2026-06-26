package io.reporthub.reportstudio.dto;

/** Report category with required minimum and currently registered count. */
public record CategoryDto(
        String id,
        String ref,
        String name,
        int min,
        long registered
) {}
