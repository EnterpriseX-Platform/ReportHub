package io.reporthub.reportstudio.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Job;
import io.reporthub.reportstudio.dto.JobDto;
import io.reporthub.reportstudio.dto.QueueStatsDto;
import io.reporthub.reportstudio.gateway.RenderWorker;
import io.reporthub.reportstudio.repo.JobRepository;
import io.reporthub.reportstudio.web.NotFoundException;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
@Transactional(readOnly = true)
public class QueueService {

    private final JobRepository jobs;
    /**
     * Present only on pods with the renderer enabled (app.worker.enabled=true).
     *
     * <p>Since the worker runs as a separate Deployment, API pods have no such bean, so it must be
     * optional — otherwise the app fails to start ("QueueService required a bean of type RenderWorker").
     */
    private final org.springframework.beans.factory.ObjectProvider<RenderWorker> renderWorker;

    /** Configured pool size — API pods read the same value even without a renderer of their own. */
    @org.springframework.beans.factory.annotation.Value("${app.render.concurrency:4}")
    private int renderConcurrency;

    public QueueService(JobRepository jobs,
                        org.springframework.beans.factory.ObjectProvider<RenderWorker> renderWorker) {
        this.jobs = jobs;
        this.renderWorker = renderWorker;
    }

    /** Job states a caller may filter on. */
    public static final java.util.Set<String> STATES = java.util.Set.of("queued", "running", "done", "error", "cancelled");

    public List<JobDto> list(String state, String report, Integer limit) {
        if (state != null && !state.isBlank() && !STATES.contains(state.trim())) {
            throw new io.reporthub.reportstudio.web.BadRequestException("Unknown state '" + state
                    + "'. Allowed: " + String.join(", ", new java.util.TreeSet<>(STATES)));
        }
        var stream = jobs.findAllByOrderByStartedAtDesc().stream();
        // Non-admins see only the jobs they requested (other people's parameters and files are theirs).
        var me = io.reporthub.reportstudio.iam.CurrentPrincipal.get().orElse(null);
        if (me != null && !me.admin()) {
            String user = me.username();
            stream = stream.filter(j -> user != null && user.equalsIgnoreCase(j.getRequestedBy()));
        }
        if (state != null && !state.isBlank()) {
            String st = state.trim();
            stream = stream.filter(j -> j.getState().equals(st));
        }
        if (report != null && !report.isBlank()) {
            stream = stream.filter(j -> report.equals(j.getReportCode()));
        }
        if (limit != null && limit > 0) {
            stream = stream.limit(limit);
        }
        return stream.map(QueueService::toDto).toList();
    }

    public QueueStatsDto stats() {
        long active = jobs.countByState("running") + jobs.countByState("queued");
        Map<String, Long> pipeline = jobs.countActiveByStage().stream()
                .collect(Collectors.toMap(JobRepository.StageCount::getStage, JobRepository.StageCount::getCount));
        long completed1h = jobs.countByStateAndStartedAtAfter("done",
                java.time.OffsetDateTime.now().minusHours(1));
        // Average time the currently queued jobs have been waiting.
        long avgWaitMs = Math.round(jobs.findAllByOrderByStartedAtDesc().stream()
                .filter(j -> "queued".equals(j.getState()) && j.getStartedAt() != null
                        && j.getStartedAt().isAfter(java.time.OffsetDateTime.now().minusHours(1)))
                .mapToLong(j -> java.time.Duration.between(j.getStartedAt(),
                        java.time.OffsetDateTime.now()).toMillis())
                .average().orElse(0));

        // The queue is the job table: "lag" = jobs waiting to be claimed, cluster-wide.
        long queued = jobs.countByState("queued");
        long running = jobs.countByState("running");
        int wConc = renderConcurrency;
        int wActive = (int) running;
        RenderWorker local = renderWorker.getIfAvailable();
        if (local != null) {
            // This pod hosts a renderer: report its configured pool size. Active/queued stay the
            // cross-pod figures from the table, which is what the Queue Monitor is about.
            wConc = local.workerSnapshot().concurrency();
        }
        int lag = (int) Math.min(Integer.MAX_VALUE, queued);
        // There are no broker partitions any more; expose the single table queue as partition 0 so the
        // Queue Monitor's existing partition panel keeps working.
        List<QueueStatsDto.PartitionStat> partitions = List.of(new QueueStatsDto.PartitionStat(0, queued));
        return new QueueStatsDto(active, completed1h, (int) avgWaitMs, lag, pipeline,
                wConc, wActive, lag, partitions,
                jobs.countByStateAndStartedAtAfter("error", java.time.OffsetDateTime.now().minusHours(1)),
                jobs.countByStateAndStartedAtAfter("cancelled", java.time.OffsetDateTime.now().minusHours(1)));
    }

    /** The captured run log persisted on a failed job (null if none was captured). */
    public String jobLog(String id) {
        Job j = jobs.findById(id)
                .orElseThrow(() -> new NotFoundException("Job not found: " + id));
        return j.getErrorDetail();
    }

    static JobDto toDto(Job j) {
        return new JobDto(j.getId(), j.getReportCode(), j.getReportName(), j.getStage(), j.getState(),
                j.getFmt(), j.getDatasourceId(), j.getRequestedBy(), j.getStartedAt(),
                j.getProgress(), j.getPartition(), j.getPriority(), j.getErrorMessage(), j.getWarning());
    }
}
