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
 * An ordered set of existing building blocks — warehouse pipelines and data checks — run as one
 * unit. Nothing about any particular data flow is encoded here: the steps are rows the user
 * composes, so "refresh the staging data, then check it, then refresh the target table" is configuration, not code.
 */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "etl_chain")
@Getter
@Setter
public class EtlChain extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    private String description;

    /** Free-text grouping, same convention as pipelines and checks. */
    private String folder;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt = OffsetDateTime.now();
}
