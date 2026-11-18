package io.reporthub.reportstudio.dto;

/** Report category with required minimum and currently registered count. */
public record CategoryDto(
        String id,
        String ref,
        String name,
        int min,
        long registered,
        String description,
        int sortOrder
) {
    /** Create/update body for POST/PUT /categories. */
    public record Request(String id, String name, String description, Integer sortOrder) {}
}
