package io.reporthub.reportstudio.gateway;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Job;
import io.reporthub.reportstudio.repo.JobRepository;

import java.time.OffsetDateTime;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Entry point for submitting a report render to the asynchronous gateway.
 *
 * <p>{@link #submit} persists a fresh {@link Job} row (state {@code queued}, stage {@code queue})
 * with a generated id of the form {@code J-<counter>}, then produces a JSON {@link JobMessage} to
 * the {@code report.jobs} Kafka topic for {@link RenderWorker} to pick up. The job id is returned
 * immediately so the caller can poll {@code GET /jobs/{id}} for progress.
 *
 * <p>Producing to Kafka is best-effort: if the broker is unreachable the job row is still created
 * (state {@code queued}) and the failure is logged rather than propagated, keeping the submit path
 * non-fatal when the broker is down.
 */
@Service
public class JobGateway {

    private static final Logger log = LoggerFactory.getLogger(JobGateway.class);

    /** Base used when no prior J-<n> rows exist, so generated ids continue past the seed data. */
    private static final long ID_BASE = 90_500L;

    private final JobRepository jobs;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper mapper;

    private final AtomicLong counter = new AtomicLong();
    private volatile boolean counterInitialized = false;

    public JobGateway(JobRepository jobs,
                      KafkaTemplate<String, String> kafkaTemplate,
                      ObjectMapper kafkaObjectMapper) {
        this.jobs = jobs;
        this.kafkaTemplate = kafkaTemplate;
        this.mapper = kafkaObjectMapper;
    }

    /**
     * Create a queued job and publish it for rendering.
     *
     * @return the generated job id (e.g. {@code J-90501})
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
                         String priority) {

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
        jobs.save(job);

        JobMessage msg = new JobMessage(
                jobId, reportCode, name, engine, fmt,
                params, sqlStatement, datasourceId, requestedBy);

        // Publish AFTER the transaction commits so the consumer never receives the
        // Kafka message before the job row is visible in the database (race condition
        // that caused "Received message for unknown job; ignoring" within milliseconds).
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    publish(jobId, msg);
                }
            });
        } else {
            publish(jobId, msg);
        }

        return jobId;
    }

    /** Re-publish an existing job (used by the retry endpoint). */
    public void publish(String jobId, JobMessage msg) {
        try {
            String json = mapper.writeValueAsString(msg);
            kafkaTemplate.send(KafkaConfig.TOPIC_REPORT_JOBS, jobId, json)
                    .whenComplete((result, ex) -> {
                        if (ex != null) {
                            log.warn("Failed to publish job {} to {} (broker down?): {}",
                                    jobId, KafkaConfig.TOPIC_REPORT_JOBS, ex.toString());
                        } else {
                            log.info("Published job {} to {}", jobId, KafkaConfig.TOPIC_REPORT_JOBS);
                        }
                    });
        } catch (JsonProcessingException e) {
            log.error("Failed to serialize job {} message", jobId, e);
        } catch (Exception e) {
            // Producer can throw synchronously (e.g. metadata timeout) when the broker is unreachable.
            log.warn("Could not enqueue job {} (broker unreachable?): {}", jobId, e.toString());
        }
    }

    private String nextJobId() {
        if (!counterInitialized) {
            initCounter();
        }
        return "J-" + counter.incrementAndGet();
    }

    /** Seed the counter from the highest existing numeric J-<n> id so generated ids never collide. */
    private synchronized void initCounter() {
        if (counterInitialized) {
            return;
        }
        long max = ID_BASE;
        try {
            for (Job j : jobs.findAll()) {
                String id = j.getId();
                if (id != null && id.startsWith("J-")) {
                    try {
                        max = Math.max(max, Long.parseLong(id.substring(2)));
                    } catch (NumberFormatException ignore) {
                        // non-numeric suffix; skip
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Could not scan existing job ids; starting counter at {}", ID_BASE, e);
        }
        counter.set(max);
        counterInitialized = true;
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
