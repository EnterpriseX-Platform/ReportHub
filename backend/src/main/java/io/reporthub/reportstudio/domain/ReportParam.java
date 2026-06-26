package io.reporthub.reportstudio.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

import java.io.Serializable;
import java.util.Objects;

/** Ordered assignment of a catalog parameter to a report. */
@Entity
@Table(name = "report_param")
@IdClass(ReportParam.Key.class)
@Getter
@Setter
public class ReportParam {

    @Id
    @Column(name = "report_code")
    private String reportCode;

    @Id
    @Column(name = "param_name")
    private String paramName;

    @Column(name = "sort_order", nullable = false)
    private int sortOrder;

    /** Per-report required override: null = inherit/not enforced, true = required here, false = optional here. */
    @Column(name = "required_override")
    private Boolean requiredOverride;

    public static class Key implements Serializable {
        private String reportCode;
        private String paramName;

        public Key() {}
        public Key(String reportCode, String paramName) {
            this.reportCode = reportCode;
            this.paramName = paramName;
        }
        @Override public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof Key k)) return false;
            return Objects.equals(reportCode, k.reportCode) && Objects.equals(paramName, k.paramName);
        }
        @Override public int hashCode() { return Objects.hash(reportCode, paramName); }
    }
}
