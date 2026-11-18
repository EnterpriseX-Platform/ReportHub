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

/** A binary asset (image) referenced by a document; the bytes are stored in MinIO under {@code objectKey}. */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "document_asset")
@Getter
@Setter
public class DocumentAsset extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "document_id")
    private Long documentId;

    @Column(name = "object_key", nullable = false)
    private String objectKey;

    @Column(nullable = false)
    private String filename;

    @Column(name = "content_type")
    private String contentType;

    @Column(name = "size_bytes")
    private Long sizeBytes;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;
}
