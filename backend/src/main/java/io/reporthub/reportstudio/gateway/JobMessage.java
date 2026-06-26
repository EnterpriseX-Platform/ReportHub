package io.reporthub.reportstudio.gateway;

import java.util.Map;

/**
 * JSON envelope produced to {@code report.jobs} by {@link JobGateway} and consumed by
 * {@link RenderWorker}. Carries everything the worker needs to build a
 * {@link io.reporthub.reportstudio.render.RenderRequest} without re-reading the database.
 *
 * @param jobId        the {@code Job} row id (e.g. {@code J-90413})
 * @param reportCode   report code being rendered
 * @param name       Thai display name (report title)
 * @param engine       render engine hint (jasper / composite / sql)
 * @param format       requested output format (PDF / XLSX / CSV)
 * @param params       arbitrary report parameters (may be empty / null)
 * @param sqlStatement optional SQL statement to drive the dataset (may be null)
 * @param datasourceId datasource identifier (may be null)
 * @param requestedBy  username that submitted the run (may be null)
 */
public record JobMessage(
        String jobId,
        String reportCode,
        String name,
        String engine,
        String format,
        Map<String, Object> params,
        String sqlStatement,
        String datasourceId,
        String requestedBy
) {
}
