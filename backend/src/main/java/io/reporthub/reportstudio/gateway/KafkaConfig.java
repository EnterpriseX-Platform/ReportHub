package io.reporthub.reportstudio.gateway;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.annotation.EnableKafka;
import org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.kafka.core.ConsumerFactory;
import org.springframework.kafka.core.DefaultKafkaConsumerFactory;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.core.ProducerFactory;

import java.util.HashMap;
import java.util.Map;

/**
 * Kafka wiring for the report render gateway.
 *
 * <p>Payloads are plain JSON {@link String} bodies (serialized by {@link JobGateway} /
 * deserialized by {@link RenderWorker} with a shared {@link ObjectMapper}); we deliberately
 * keep the Kafka (de)serializers as {@link StringSerializer}/{@link StringDeserializer} so the
 * envelope on the wire is a readable JSON string rather than an opaque typed payload.
 *
 * <p>The {@code report.jobs} topic is auto-created at startup via the {@link NewTopic} bean
 * (picked up by Spring Boot's {@code KafkaAdmin}). The listener container factory is configured
 * with {@code missing-topics-fatal=false} so the application still boots when the broker is
 * unreachable (the listener simply stays idle / retries) instead of failing fast.
 */
@Configuration
@EnableKafka
public class KafkaConfig {

    /** Topic carrying queued render jobs. */
    public static final String TOPIC_REPORT_JOBS = "report.jobs";

    private final String bootstrapServers;
    private final String consumerGroup;
    private final String autoOffsetReset;

    public KafkaConfig(
            @Value("${spring.kafka.bootstrap-servers:localhost:9092}") String bootstrapServers,
            @Value("${spring.kafka.consumer.group-id:report-studio}") String consumerGroup,
            @Value("${spring.kafka.consumer.auto-offset-reset:earliest}") String autoOffsetReset) {
        this.bootstrapServers = bootstrapServers;
        this.consumerGroup = consumerGroup;
        this.autoOffsetReset = autoOffsetReset;
    }

    /**
     * Shared JSON mapper used to (de)serialize the message envelope.
     * Declaring an ObjectMapper bean makes Spring Boot back off its auto-configured one,
     * so this bean also becomes the MVC mapper — it MUST handle java.time (OffsetDateTime)
     * or every REST response with a timestamp 500s.
     */
    @Bean
    public ObjectMapper kafkaObjectMapper() {
        return new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    }

    /** Auto-create the report.jobs topic (single partition is enough for this gateway). */
    @Bean
    public NewTopic reportJobsTopic() {
        return TopicBuilder.name(TOPIC_REPORT_JOBS)
                .partitions(1)
                .replicas(1)
                .build();
    }

    // ---- Producer ---------------------------------------------------------

    @Bean
    public ProducerFactory<String, String> producerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        // Do not block the request thread forever when the broker is down.
        props.put(ProducerConfig.MAX_BLOCK_MS_CONFIG, 5_000);
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        return new DefaultKafkaProducerFactory<>(props);
    }

    @Bean
    public KafkaTemplate<String, String> kafkaTemplate(ProducerFactory<String, String> pf) {
        return new KafkaTemplate<>(pf);
    }

    // ---- Consumer ---------------------------------------------------------

    @Bean
    public ConsumerFactory<String, String> consumerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, consumerGroup);
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, autoOffsetReset);
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, true);
        // Default 5-min interval is too short for heavy Jasper renders that take 10-20 min.
        // 30 minutes gives renders enough headroom without losing the heartbeat entirely.
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, 1_800_000);
        return new DefaultKafkaConsumerFactory<>(props);
    }

    /**
     * Listener container factory referenced by {@link RenderWorker}'s {@code @KafkaListener}.
     * {@code missing-topics-fatal=false} makes the worker NON-FATAL if the broker is down or the
     * topic does not yet exist, so the rest of the application still starts and serves traffic.
     */
    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, String> kafkaListenerContainerFactory(
            ConsumerFactory<String, String> consumerFactory) {
        ConcurrentKafkaListenerContainerFactory<String, String> factory =
                new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(consumerFactory);
        factory.setMissingTopicsFatal(false);
        return factory;
    }
}
