package io.reporthub.reportstudio.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;
import io.reporthub.reportstudio.security.AuthTokenConverter;

import java.time.OffsetDateTime;

/** An installed report engine (built-in, remote URL/service, or JAR/lib plugin). */
@Entity
@Table(name = "engine_instance")
@Getter
@Setter
public class EngineInstance {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private String kind;

    @Column(name = "install_method", nullable = false)
    private String installMethod;

    @Column(name = "base_url")
    private String baseUrl;

    @Convert(converter = AuthTokenConverter.class)
    @Column(name = "auth_token")
    private String authToken;

    @Column(name = "component_format")
    private String componentFormat;

    @Column(name = "artifact_ref")
    private String artifactRef;

    @Column(nullable = false)
    private boolean enabled = true;

    private String note;

    @Column(name = "created_at", insertable = false, updatable = false)
    private OffsetDateTime createdAt;
}
