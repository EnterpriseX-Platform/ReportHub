package io.reporthub.reportstudio.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

import java.time.OffsetDateTime;

/** A BI dashboard: widgets over saved views/datasets, optionally shared via a public token. */
@Entity
@Table(name = "dashboard")
@Getter
@Setter
public class Dashboard {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    @Column(name = "layout_json", nullable = false)
    private String layoutJson;

    @Column(name = "params_json")
    private String paramsJson;

    @Column(name = "share_token")
    private String shareToken;

    @Column(name = "workspace_id")
    private Long workspaceId;

    private String folder;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;
}
