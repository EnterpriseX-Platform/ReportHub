package io.reporthub.reportstudio.domain;

import io.reporthub.reportstudio.tenancy.TenantScoped;
import org.hibernate.annotations.Filter;
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
@Filter(name = TenantScoped.FILTER)
@Table(name = "saved_view")
@Getter
@Setter
public class SavedView extends TenantScoped {

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

    /**
     * true = visible to everyone in the sidebar; false = visible only to the creator.
     *
     * Boolean (not boolean) on purpose: Lombok then generates getIsPublic()/setIsPublic(), so the
     * JSON field is "isPublic" as the UI expects. With a primitive boolean Lombok emits isPublic()
     * and Jackson strips it to "public", which the UI does not find.
     */
    @Column(name = "is_public", nullable = false)
    private Boolean isPublic = Boolean.FALSE;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;
}
