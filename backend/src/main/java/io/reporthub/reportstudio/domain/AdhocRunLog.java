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

/** One row per executed ad-hoc query — backs the real "recent queries" panel. */
@Entity
@Table(name = "adhoc_run_log")
@Getter
@Setter
public class AdhocRunLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String dataset;

    @Column(nullable = false)
    private String fields;

    private String filters;

    @Column(name = "row_count", nullable = false)
    private int rowCount;

    @Column(name = "created_by")
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;
}
