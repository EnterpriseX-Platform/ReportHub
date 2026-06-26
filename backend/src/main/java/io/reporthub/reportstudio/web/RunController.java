package io.reporthub.reportstudio.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
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
 * Run / lifecycle endpoints layered on top of the Kafka render gateway.
 *
 * <ul>
 *   <li>{@code POST /reports/{code}/run}  — submit a render, returns {@code {jobId}}</li>
 *   <li>{@code POST /jobs/{id}/retry}     — re-queue a job (re-publish to report.jobs)</li>
 *   <li>{@code POST /jobs/{id}/cancel}    — mark a queued/running job as error (cancelled)</li>
 *   <li>{@code GET  /jobs/{id}}           — fetch a single job DTO</li>
 * </ul>
 */
@RestController
public class RunController {

    private final ReportRepository reports;
    private final JobRepository jobs;
    private final JobGateway gateway;
    private final ParameterService parameters;

    public RunController(ReportRepository reports,
                         JobRepository jobs,
                         JobGateway gateway,
                         ParameterService parameters) {
        this.reports = reports;
        this.jobs = jobs;
        this.gateway = gateway;
        this.parameters = parameters;
    }

    /** Submit a render run for a registered report. */
    @PostMapping("/reports/{code}/run")
    public RunResponse run(@PathVariable String code,
                           @RequestBody(required = false) RunReportRequest body,
                           org.springframework.security.core.Authentication auth) {
        Report report = reports.findByCode(code)
                .orElseThrow(() -> new NotFoundException("Report not found: " + code));

        RunReportRequest req = body != null ? body : new RunReportRequest(null, null, null);
        String format = resolveFormat(req.format(), report.getFormats());
        // Keep only params the report declares — drops any extra value a caller might inject for an
        // engine to substitute (SQL / api endpoint). No-op for reports with no declared params.
        Map<String, Object> params = parameters.retainDeclared(code, req.params());
        // Enforce per-report required params (opt-in: only those marked required for this report).
        parameters.validateRequired(code, params);
        String requestedBy = auth == null ? "console" : auth.getName();

        String jobId = gateway.submit(
                report.getCode(),
                report.getName(),
                report.getEngine(),
                format,
                params,
                null,                       // sqlStatement: resolved by the renderer from the report definition
                report.getDatasourceId(),
                requestedBy,
                req.priority());

        return new RunResponse(jobId);
    }

    /** Re-queue an existing job. */
    @PostMapping("/jobs/{id}/retry")
    public RunResponse retry(@PathVariable String id) {
        Job job = jobs.findById(id)
                .orElseThrow(() -> new NotFoundException("Job not found: " + id));

        job.setState("queued");
        job.setStage("queue");
        job.setProgress(0);
        jobs.save(job);

        JobMessage msg = new JobMessage(
                job.getId(),
                job.getReportCode(),
                job.getReportName(),
                reports.findByCode(job.getReportCode()).map(Report::getEngine).orElse("jasper"),
                job.getFmt(),
                Map.of(),
                null,
                job.getDatasourceId(),
                job.getRequestedBy());
        gateway.publish(job.getId(), msg);

        return new RunResponse(job.getId());
    }

    /** Cancel a queued/running job (terminal: marked as error). */
    @PostMapping("/jobs/{id}/cancel")
    public JobDto cancel(@PathVariable String id) {
        Job job = jobs.findById(id)
                .orElseThrow(() -> new NotFoundException("Job not found: " + id));

        if ("done".equals(job.getState())) {
            throw new BadRequestException("Job already completed: " + id);
        }
        job.setState("error");
        jobs.save(job);
        return toDto(job);
    }

    /** Fetch one job. */
    @GetMapping("/jobs/{id}")
    public JobDto get(@PathVariable String id) {
        Job job = jobs.findById(id)
                .orElseThrow(() -> new NotFoundException("Job not found: " + id));
        return toDto(job);
    }

    private static String resolveFormat(String requested, String reportFormatsCsv) {
        if (requested != null && !requested.isBlank()) {
            return requested.trim().toUpperCase();
        }
        if (reportFormatsCsv != null && !reportFormatsCsv.isBlank()) {
            return reportFormatsCsv.split(",")[0].trim().toUpperCase();
        }
        return "PDF";
    }

    private static JobDto toDto(Job j) {
        return new JobDto(j.getId(), j.getReportCode(), j.getReportName(), j.getStage(), j.getState(),
                j.getFmt(), j.getDatasourceId(), j.getRequestedBy(), j.getStartedAt(),
                j.getProgress(), j.getPartition(), j.getPriority(), j.getErrorMessage());
    }

    /** Minimal {jobId} response for run / retry. */
    public record RunResponse(String jobId) {
    }
}
