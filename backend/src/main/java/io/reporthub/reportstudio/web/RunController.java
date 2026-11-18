package io.reporthub.reportstudio.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.engine.builtin.OtherEngine;
import io.reporthub.reportstudio.domain.Job;
import io.reporthub.reportstudio.domain.Report;
import io.reporthub.reportstudio.dto.JobDto;
import io.reporthub.reportstudio.gateway.JobGateway;
import io.reporthub.reportstudio.gateway.JobMessage;
import io.reporthub.reportstudio.repo.JobRepository;
import io.reporthub.reportstudio.repo.ReportRepository;
import io.reporthub.reportstudio.service.ParameterService;

import java.util.Map;

/**
 * Run / lifecycle endpoints layered on top of the render gateway (Postgres-backed job queue).
 *
 * <ul>
 *   <li>{@code POST /reports/{code}/run}  — submit a render, returns {@code {jobId}}</li>
 *   <li>{@code POST /jobs/{id}/retry}     — re-queue a job (back to state queued)</li>
 *   <li>{@code POST /jobs/{id}/cancel}    — mark a queued/running job as cancelled</li>
 *   <li>{@code GET  /jobs/{id}}           — fetch a single job DTO</li>
 * </ul>
 */
@RestController
public class RunController {

    private final ReportRepository reports;
    private final JobRepository jobs;
    private final JobGateway gateway;
    private final ParameterService parameters;
    private final io.reporthub.reportstudio.render.JobCancelRegistry cancelRegistry;

    public RunController(ReportRepository reports,
                         JobRepository jobs,
                         JobGateway gateway,
                         ParameterService parameters,
                         io.reporthub.reportstudio.render.JobCancelRegistry cancelRegistry) {
        this.reports = reports;
        this.jobs = jobs;
        this.gateway = gateway;
        this.parameters = parameters;
        this.cancelRegistry = cancelRegistry;
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.acl.AclService acl;

    /** Submit a render run for a registered report. */
    @PostMapping("/reports/{code}/run")
    public RunResponse run(@PathVariable String code,
                           @RequestBody(required = false) RunReportRequest body,
                           org.springframework.security.core.Authentication auth) {
        if (acl != null) acl.require("REPORT", code, "run");
        Report report = reports.findByCode(code)
                .orElseThrow(() -> new NotFoundException("Report not found: " + code));

        // The "other" engine produces no file. If queued, the job would die in the worker and show up as
        // an error mixed with real failures, skewing error stats — reject it up front with a clear reason.
        // The Run Task screen already hides the button; this guards direct API calls and the scheduler.
        if (OtherEngine.KIND.equalsIgnoreCase(report.getEngine())) {
            throw new BadRequestException("Report " + code + " uses the 'other' engine, which is information only "
                    + "and produces no file. Point it at a real engine before running it.");
        }

        RunReportRequest req = body != null ? body : new RunReportRequest(null, null, null);
        String format = resolveFormat(req.format(), report.getFormats());
        // Keep only params the report declares — drops any extra value a caller might inject for an
        // engine to substitute (SQL / api endpoint). No-op for reports with no declared params.
        Map<String, Object> params = new java.util.LinkedHashMap<>();
        Map<String, Object> declared = parameters.retainDeclared(code, req.params());
        if (declared != null) params.putAll(declared);
        if (req.watermark() != null && !req.watermark().isBlank()) {
            params.put(io.reporthub.reportstudio.render.PdfWatermark.PARAM, req.watermark().trim());
        }
        String priority = req.priority() != null && !req.priority().isBlank()
                ? io.reporthub.reportstudio.service.ReportService.validPriority(req.priority())
                : (report.getPriority() == null ? "normal" : report.getPriority());
        // Enforce per-report required params (opt-in: only those marked required for this report).
        parameters.validateRequired(code, params);
        String requestedBy = auth == null ? "console" : auth.getName();
        // Edge SSO passthrough: when this run was authenticated by the central gateway's Keycloak token,
        // EdgeBearerAuthFilter stashed the raw token as the credentials. Carry it through the async render
        // pipeline so an api-engine report that opts in (forwardEdgeToken) can call a gateway-fronted
        // endpoint (e.g. another service's /api/export) AS this user. The rs.token admin path leaves
        // credentials null, so nothing is forwarded there — MDP-style reports run only via the edge.
        String callerToken = (auth != null && auth.getCredentials() instanceof String cred && !cred.isBlank())
                ? cred : null;

        String jobId = gateway.submit(
                report.getCode(),
                report.getName(),
                report.getEngine(),
                format,
                params,
                null,                       // sqlStatement: resolved by the renderer from the report definition
                report.getDatasourceId(),
                requestedBy,
                priority,
                callerToken);

        return new RunResponse(jobId);
    }

    /** Re-queue an existing job. */
    @PostMapping("/jobs/{id}/retry")
    public RunResponse retry(@PathVariable String id) {
        Job job = jobs.findById(id)
                .orElseThrow(() -> new NotFoundException("Job not found: " + id));
        if (!isRetryable(job.getState())) {
            throw new io.reporthub.reportstudio.web.ConflictException("Only failed or cancelled jobs can be retried (job "
                    + id + " is " + job.getState() + ")");
        }

        // Fallback envelope only for jobs enqueued before payloads were stored; otherwise the
        // original payload (params included) is re-run as-is.
        JobMessage fallback = new JobMessage(
                job.getId(),
                job.getReportCode(),
                job.getReportName(),
                reports.findByCode(job.getReportCode()).map(Report::getEngine).orElse("jasper"),
                job.getFmt(),
                Map.of(),
                null,
                job.getDatasourceId(),
                job.getRequestedBy(),
                null);       // retry has no fresh edge token; a forwardEdgeToken report must be re-run, not retried
        gateway.requeue(job, fallback);

        return new RunResponse(job.getId());
    }

    /** Retry is only meaningful for a job that ended without a result. */
    static boolean isRetryable(String state) {
        return "error".equals(state) || "cancelled".equals(state) || "failed".equals(state);
    }

    /** Cancel a queued/running job (terminal state "cancelled"). */
    @PostMapping("/jobs/{id}/cancel")
    public JobDto cancel(@PathVariable String id) {
        Job job = jobs.findById(id)
                .orElseThrow(() -> new NotFoundException("Job not found: " + id));

        if (!"queued".equals(job.getState()) && !"running".equals(job.getState())) {
            throw new io.reporthub.reportstudio.web.ConflictException("Only queued or running jobs can be cancelled (job "
                    + id + " is " + job.getState() + ")");
        }
        job.setState("cancelled");
        job.setErrorMessage("Cancelled from the Queue Monitor");
        job.setCallerToken(null);
        jobs.save(job);
        // A queued job is stopped by the worker's state guard alone. A RUNNING one is not: its
        // thread is already past that guard and typically blocked inside executeQuery(), which
        // ignores interrupts — so ask the registry to abort the in-flight statements as well.
        cancelRegistry.cancel(id);
        return toDto(job);
    }

    /** Fetch one job. */
    @GetMapping("/jobs/{id}")
    public JobDto get(@PathVariable String id) {
        Job job = jobs.findById(id)
                .orElseThrow(() -> new NotFoundException("Job not found: " + id));
        return toDto(job);
    }

    static String resolveFormat(String requested, String reportFormatsCsv) {
        if (requested != null && !requested.isBlank()) {
            String f = requested.trim().toUpperCase();
            if (reportFormatsCsv != null && !reportFormatsCsv.isBlank()) {
                java.util.List<String> declared = java.util.Arrays.stream(reportFormatsCsv.split(","))
                        .map(x -> x.trim().toUpperCase()).filter(x -> !x.isEmpty()).toList();
                if (!declared.isEmpty() && !declared.contains(f)) {
                    throw new BadRequestException("Format " + f + " is not offered by this report. Allowed: "
                            + String.join(", ", declared));
                }
            }
            return f;
        }
        if (reportFormatsCsv != null && !reportFormatsCsv.isBlank()) {
            return reportFormatsCsv.split(",")[0].trim().toUpperCase();
        }
        return "PDF";
    }

    private static JobDto toDto(Job j) {
        return new JobDto(j.getId(), j.getReportCode(), j.getReportName(), j.getStage(), j.getState(),
                j.getFmt(), j.getDatasourceId(), j.getRequestedBy(), j.getStartedAt(),
                j.getProgress(), j.getPartition(), j.getPriority(), j.getErrorMessage(), j.getWarning());
    }

    /** Minimal {jobId} response for run / retry. */
    public record RunResponse(String jobId) {
    }
}
