package io.reporthub.reportstudio.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

import java.time.OffsetDateTime;

/** Per-report render pipeline as a React Flow document (nodes + edges JSON). */
@Entity
@Table(name = "report_flow")
@Getter
@Setter
public class ReportFlow {

    @Id
    @Column(name = "report_code")
    private String reportCode;

    @Column(name = "flow_json", nullable = false)
    private String flowJson;

    @Column(name = "updated_by")
    private String updatedBy;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;
}
