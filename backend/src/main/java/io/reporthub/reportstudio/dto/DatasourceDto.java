package io.reporthub.reportstudio.dto;

/** Datasource connection with the number of reports using it. */
public record DatasourceDto(
        String id,
        String name,
        String engine,
        String host,
        String schemaName,
        String status,
        Integer latencyMs,
        String pool,
        long reportCount,
        boolean hasJdbc,
        boolean isDefault,
        boolean inUse      // referenced by any report/unit/dataset/param/scheduler/warehouse → cannot delete
) {}
