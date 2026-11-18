package io.reporthub.reportstudio.gateway;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Job;
import io.reporthub.reportstudio.repo.JobRepository;
import io.reporthub.reportstudio.util.Cuid2;

import java.time.OffsetDateTime;
import java.util.Map;

/**
 * Entry point for submitting a report render to the asynchronous gateway.
 *
 * <p>{@link #submit} persists a fresh {@link Job} row (state {@code queued}, stage {@code queue})
 * with a generated {@linkplain Cuid2 cuid2} id and the JSON render envelope ({@link JobMessage}) in
 * its {@code payload} column. Committing that row IS the enqueue: {@link RenderWorker} polls the
 * table through {@link JobQueue}. Because the queue and the job state live in the same database
 * transaction, a worker can never see a job before its row is committed, and no job can be lost
 * between "row saved" and "message sent".
 */
@Service
public class JobGateway {

    private final JobRepository jobs;
    private final ObjectMapper mapper;

    public JobGateway(JobRepository jobs, ObjectMapper objectMapper) {
        this.jobs = jobs;
        this.mapper = objectMapper;
    }

    /**
     * Create a queued job.
     *
     * @return the generated job id (e.g. {@code tz4a98xxat96iws9zmbrgj3a})
     */
    @Transactional
    public String submit(String reportCode,
                         String name,
                         String engine,
                         String format,
                         Map<String, Object> params,
                         String sqlStatement,
                         String datasourceId,
                         String requestedBy,
                         String priority,
                         String callerToken) {

        String jobId = nextJobId();
        String fmt = normalizeFmt(format);

        Job job = new Job();
        job.setId(jobId);
        job.setReportCode(reportCode);
        job.setReportName(name != null ? name : reportCode);
        job.setStage("queue");
        job.setState("queued");
        job.setFmt(fmt);
        job.setDatasourceId(datasourceId);
        job.setRequestedBy(requestedBy);
        job.setStartedAt(OffsetDateTime.now());
        job.setProgress(0);
        job.setPartition(0);
        job.setPriority(normalizePriority(priority));
        // The caller token is stored apart from the payload and cleared atomically when the job is claimed.
        job.setPayload(toJson(new JobMessage(
                jobId, reportCode, name, engine, fmt,
                params, sqlStatement, datasourceId, requestedBy, null)));
        job.setCallerToken(callerToken);
        // Who asked (roles + IAM attributes) so the worker applies the same row filters later.
        io.reporthub.reportstudio.iam.CurrentPrincipal.get().ifPresent(p -> {
            try { job.setPrincipalJson(mapper.writeValueAsString(p)); } catch (Exception ignored) { /* best effort */ }
        });
        jobs.save(job);
        return jobId;
    }

    /**
     * Put an existing job back on the queue (retry endpoint). The original payload is kept, so a retry
     * re-runs with the same parameters; jobs created before the payload column existed fall back to
     * {@code fallback}. A retry never carries a caller token (the original one has expired).
     */
    @Transactional
    public void requeue(Job job, JobMessage fallback) {
        job.setState("queued");
        job.setStage("queue");
        job.setProgress(0);
        job.setErrorMessage(null);
        job.setClaimedBy(null);
        job.setClaimedAt(null);
        job.setCallerToken(null);
        job.setStartedAt(OffsetDateTime.now());
        if (job.getPayload() == null && fallback != null) {
            job.setPayload(toJson(fallback));
        }
        jobs.save(job);
    }

    private String toJson(JobMessage msg) {
        try {
            return mapper.writeValueAsString(msg);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialize job " + msg.jobId(), e);
        }
    }

    /**
     * Job ids are cuid2.
     *
     * <p>The previous scheme was {@code "J-" + AtomicLong}, seeded by reading {@code jobs.findAll()} at boot
     * to find the highest number. It failed three ways:
     * <ul>
     *   <li><b>Collisions across pods</b>: the counter lived in each pod's memory, so during a rolling update
     *       old and new pods read the same maximum and handed out the same next id — a primary-key clash.</li>
     *   <li><b>Ever-slower boot</b>: every row was loaded into memory to find one number, and the table
     *       only grows.</li>
     *   <li><b>Guessable ids</b>: sequential numbers reveal other users' job ids.</li>
     * </ul>
     * cuid2 fixes all three: generated locally without a database read, fingerprinted per pod so ids do not
     * collide, and opaque.
     *
     * <p>Existing ids in the old format keep working — the column is varchar and nothing in the frontend
     * or backend parses the {@code J-<n>} format.
     */
    private String nextJobId() {
        return Cuid2.createId();
    }

    private static String normalizeFmt(String format) {
        if (format == null || format.isBlank()) {
            return "PDF";
        }
        return format.trim().toUpperCase();
    }

    private static String normalizePriority(String priority) {
        if (priority == null) {
            return "normal";
        }
        String p = priority.trim().toLowerCase();
        return switch (p) {
            case "high", "low", "normal" -> p;
            default -> "normal";
        };
    }
}
