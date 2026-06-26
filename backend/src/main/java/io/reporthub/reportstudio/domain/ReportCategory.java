package io.reporthub.reportstudio.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

/** A report category (clause + required minimum count). */
@Entity
@Table(name = "report_category")
@Getter
@Setter
public class ReportCategory {

    @Id
    private String id;

    @Column(nullable = false)
    private String ref;

    @Column(name = "name", nullable = false)
    private String name;


    @Column(name = "min_reports", nullable = false)
    private int minReports;

    @Column(name = "sort_order", nullable = false)
    private int sortOrder;
}
