package io.reporthub.reportstudio.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

/**
 * Warehouse fact row backing the Ad-hoc query and Analytics Workbench.
 * Amounts are in THB millions. Seeded deterministically by Flyway V6.
 */
@Entity
@Table(name = "fact")
@Getter
@Setter
public class Fact {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String region;

    @Column(nullable = false)
    private String category;

    @Column(nullable = false)
    private String channel;

    @Column(name = "fiscal_year", nullable = false)
    private String fiscalYear;

    /** Target amount. */
    @Column(nullable = false)
    private long target;

    /** Actual sales. */
    @Column(nullable = false)
    private long sales;

    /** Net profit. */
    @Column(nullable = false)
    private long profit;
}
