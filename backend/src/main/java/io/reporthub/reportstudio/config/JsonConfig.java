package io.reporthub.reportstudio.config;

import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Application-wide JSON mapper (job payloads, engine configs, MVC).
 *
 * <p>Declaring an ObjectMapper bean makes Spring Boot back off its auto-configured one, so this bean
 * also becomes the MVC mapper — it MUST handle java.time (OffsetDateTime) or every REST response
 * with a timestamp 500s.
 */
@Configuration
public class JsonConfig {

    @Bean
    public ObjectMapper objectMapper() {
        ObjectMapper mapper = new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        // This bean is ALSO the MVC request mapper. Plugin-JAR and template uploads send the file
        // gzip+base64 inside a single JSON string field; a ~30 MB fat engine jar lands ~20 MB of base64,
        // which trips Jackson's default 20 MB max string length (StreamReadConstraints). Raise the cap
        // so large engine/template uploads parse instead of failing at JSON-read time.
        mapper.getFactory().setStreamReadConstraints(
                StreamReadConstraints.builder().maxStringLength(200_000_000).build());
        return mapper;
    }
}
