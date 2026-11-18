package io.reporthub.reportstudio.acl;

import io.reporthub.reportstudio.tenancy.TenantScoped;
import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import org.hibernate.annotations.Filter;

import java.time.OffsetDateTime;

/**
 * Level 2: who may use one object. An object with no entries is open to anyone who passes the
 * level-1 (screen) check; once it has entries, only matching principals get in.
 */
@Entity
@Table(name = "acl_entry")
@Filter(name = TenantScoped.FILTER)
@Getter
@Setter
public class AclEntry extends TenantScoped {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** REPORT | DATASOURCE | DATASET | REPO_TABLE | DASHBOARD | OUTPUT */
    @Column(name = "object_type", nullable = false, length = 32)
    private String objectType;

    @Column(name = "object_id", nullable = false, length = 200)
    private String objectId;

    /** role | responsibility | user */
    @Column(name = "principal_type", nullable = false, length = 32)
    private String principalType;

    @Column(name = "principal_code", nullable = false, length = 200)
    private String principalCode;

    /** view | run | edit (each includes the ones before it) */
    @Column(nullable = false, length = 16)
    private String permission;

    @Column(name = "created_by", length = 200)
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();
}
