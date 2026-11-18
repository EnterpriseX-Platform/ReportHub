package io.reporthub.reportstudio.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.OffsetDateTime;

/**
 * A reviewer's confirmation that a processed output file has been checked.
 *
 * <p>Keyed by the file's object key, not the report code, because one report can be processed many
 * times; keyed by report, a confirmation of an old file would silently carry over to a new unseen one.
 */
@Entity
@Table(name = "output_review")
public class OutputReview {

    @Id
    @Column(name = "object_key", length = 512, nullable = false)
    private String objectKey;

    @Column(name = "report_code", length = 64, nullable = false)
    private String reportCode;

    @Column(name = "confirmed_by", length = 64, nullable = false)
    private String confirmedBy;

    @Column(name = "confirmed_at", nullable = false)
    private OffsetDateTime confirmedAt = OffsetDateTime.now();

    @Column(name = "note", length = 500)
    private String note;

    public String getObjectKey() { return objectKey; }
    public void setObjectKey(String v) { this.objectKey = v; }

    public String getReportCode() { return reportCode; }
    public void setReportCode(String v) { this.reportCode = v; }

    public String getConfirmedBy() { return confirmedBy; }
    public void setConfirmedBy(String v) { this.confirmedBy = v; }

    public OffsetDateTime getConfirmedAt() { return confirmedAt; }
    public void setConfirmedAt(OffsetDateTime v) { this.confirmedAt = v; }

    public String getNote() { return note; }
    public void setNote(String v) { this.note = v; }
}
