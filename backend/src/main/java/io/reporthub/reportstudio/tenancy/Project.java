package io.reporthub.reportstudio.tenancy;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

import java.io.Serializable;
import java.time.OffsetDateTime;

/** A project inside a tenant; maps to an IAM Application code. */
@Entity
@Table(name = "project")
@IdClass(Project.Key.class)
@Getter
@Setter
public class Project {

    public record Key(String tenantId, String id) implements Serializable {
        public Key() { this(null, null); }
    }

    @Id
    @Column(name = "tenant_id", length = 64)
    private String tenantId;

    @Id
    @Column(length = 64)
    private String id;

    @Column(nullable = false, length = 200)
    private String name;

    /** IAM Application code this project corresponds to (object codes live under it). */
    @Column(name = "iam_app_code", length = 100)
    private String iamAppCode;

    @Column(nullable = false)
    private boolean active = true;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();
}
