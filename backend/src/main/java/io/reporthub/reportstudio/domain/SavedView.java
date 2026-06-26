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

/** A saved Analytics Workbench pivot or Ad-hoc query (payload = replayable request JSON). */
@Entity
@Table(name = "saved_view")
@Getter
@Setter
public class SavedView {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String kind;

    @Column(nullable = false)
    private String name;

    private String dataset;

    @Column(nullable = false)
    private String payload;

    @Column(name = "workspace_id")
    private Long workspaceId;

    private String folder;

    @Column(name = "share_token")
    private String shareToken;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;
}
