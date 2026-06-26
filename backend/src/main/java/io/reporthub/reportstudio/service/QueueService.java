package io.reporthub.reportstudio.service;

import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.ListOffsetsResult;
import org.apache.kafka.clients.admin.OffsetSpec;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Job;
import io.reporthub.reportstudio.dto.JobDto;
import io.reporthub.reportstudio.dto.QueueStatsDto;
import io.reporthub.reportstudio.repo.JobRepository;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
@Transactional(readOnly = true)
public class QueueService {

    private final JobRepository jobs;
    private final KafkaAdmin kafkaAdmin;
    private final String consumerGroup;

    private volatile long cachedLag = 0;
    private volatile long lagFetchedAt = 0;

    public QueueService(JobRepository jobs,
                        KafkaAdmin kafkaAdmin,
                        @org.springframework.beans.factory.annotation.Value("${spring.kafka.consumer.group-id:report-studio}") String consumerGroup) {
        this.jobs = jobs;
        this.kafkaAdmin = kafkaAdmin;
        this.consumerGroup = consumerGroup;
    }

    public List<JobDto> list(String state, String report, Integer limit) {
        var stream = jobs.findAllByOrderByStartedAtDesc().stream();
        if (state != null && !state.isBlank()) {
            stream = stream.filter(j -> j.getState().equals(state));
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
        return new QueueStatsDto(active, completed1h, (int) avgWaitMs, (int) Math.min(Integer.MAX_VALUE, consumerLag()), pipeline);
    }

    /** Real Kafka consumer lag for the report.jobs group (cached ~5s; 0 on failure). */
    private long consumerLag() {
        long now = System.currentTimeMillis();
        if (now - lagFetchedAt < 5000) return cachedLag;
        try (AdminClient admin = AdminClient.create(kafkaAdmin.getConfigurationProperties())) {
            Map<TopicPartition, OffsetAndMetadata> committed = admin
                    .listConsumerGroupOffsets(consumerGroup)
                    .partitionsToOffsetAndMetadata().get(3, java.util.concurrent.TimeUnit.SECONDS);
            if (committed.isEmpty()) { cachedLag = 0; lagFetchedAt = now; return 0; }
            Map<TopicPartition, OffsetSpec> q = new java.util.HashMap<>();
            committed.keySet().forEach(tp -> q.put(tp, OffsetSpec.latest()));
            Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> ends =
                    admin.listOffsets(q).all().get(3, java.util.concurrent.TimeUnit.SECONDS);
            long lag = 0;
            for (var e : committed.entrySet()) {
                var end = ends.get(e.getKey());
                if (end != null) lag += Math.max(0, end.offset() - e.getValue().offset());
            }
            cachedLag = lag;
            lagFetchedAt = now;
            return lag;
        } catch (Exception e) {
            lagFetchedAt = now;
            return cachedLag;
        }
    }

    static JobDto toDto(Job j) {
        return new JobDto(j.getId(), j.getReportCode(), j.getReportName(), j.getStage(), j.getState(),
                j.getFmt(), j.getDatasourceId(), j.getRequestedBy(), j.getStartedAt(),
                j.getProgress(), j.getPartition(), j.getPriority(), j.getErrorMessage());
    }
}
