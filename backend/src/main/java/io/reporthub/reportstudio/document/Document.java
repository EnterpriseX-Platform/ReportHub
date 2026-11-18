package io.reporthub.reportstudio.document;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import io.reporthub.reportstudio.tenancy.TenantScoped;
import lombok.Getter;
import org.hibernate.annotations.Filter;
import lombok.Setter;

import java.time.OffsetDateTime;

/** A page-layout document authored in the Documents editor; {@code content} is the JSON body. */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "document")
@Getter
@Setter
public class Document extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String title;

    private String description;

    private String folder;

    @Column(nullable = false)
    private String content;

    @Column(nullable = false)
    private Integer revision = 1;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    @Column(name = "updated_by")
    private String updatedBy;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    /** FileHub publication (null = not published). */
    @Column(name = "filehub_connector_id", length = 64)
    private String filehubConnectorId;

    @Column(name = "filehub_file_id", length = 128)
    private String filehubFileId;

    @Column(name = "filehub_url", columnDefinition = "TEXT")
    private String filehubUrl;

    @Column(name = "filehub_published_at")
    private OffsetDateTime filehubPublishedAt;
}
