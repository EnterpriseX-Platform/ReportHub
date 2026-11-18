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

/**
 * A folder in the Tables screen's navigation sidebar.
 *
 * Previously folders were just '/'-separated text in {@code repo_table.folder}, which could group and nest
 * but could not store the order users drag items into, and had nowhere to keep empty folders.
 */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "repo_folder")
@Getter
@Setter
public class RepoFolder extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    /** Portal menu this folder belongs to — same set as {@code repo_table.menu_key}. */
    @Column(name = "menu_key")
    private String menuKey;

    /** Parent folder; null = top level. */
    @Column(name = "parent_id")
    private Integer parentId;

    @Column(nullable = false)
    private String name;

    /** Order among siblings, lowest first. */
    @Column(name = "sort_order", nullable = false)
    private Integer sortOrder = 0;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt = OffsetDateTime.now();
}
