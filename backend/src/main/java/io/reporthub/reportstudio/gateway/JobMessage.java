package io.reporthub.reportstudio.gateway;

import java.util.Map;

/**
 * JSON render envelope stored in {@code job.payload} by {@link JobGateway} and read back by
 * {@link RenderWorker} when it claims the job. Carries everything the worker needs to build a
 * {@link io.reporthub.reportstudio.render.RenderRequest} without re-reading the database.
 *
 * @param jobId        the {@code Job} row id (e.g. {@code J-90413})
 * @param reportCode   report code being rendered
 * @param name       display name (report title)
 * @param engine       render engine hint (jasper / composite / sql)
 * @param format       requested output format (PDF / XLSX / CSV)
 * @param params       arbitrary report parameters (may be empty / null)
 * @param sqlStatement optional SQL statement to drive the dataset (may be null)
 * @param datasourceId datasource identifier (may be null)
 * @param requestedBy  username that submitted the run (may be null)
 * @param callerToken  SENSITIVE — the caller's verified Keycloak access token, present ONLY when the
 *                     run was authenticated at the edge (see {@code EdgeBearerAuthFilter}); null for the
 *                     rs.token admin path and console runs. Carried here so the async worker can forward
 *                     it from an opt-in api-engine report (see {@code ApiReportEngine.forwardEdgeToken})
 *                     to a gateway-fronted endpoint, rendering AS the real user. It is never written
 *                     into {@code job.payload}: it is held in the separate {@code job.caller_token}
 *                     column only while the job is queued and is cleared in the same statement that
 *                     claims the job. Its exposure is also bounded by the token's own short lifetime.
 *                     Never log it.
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
        String requestedBy,
        String callerToken
) {
}
