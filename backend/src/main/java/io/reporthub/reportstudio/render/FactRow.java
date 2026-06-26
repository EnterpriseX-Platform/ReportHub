package io.reporthub.reportstudio.render;

import lombok.Getter;
import lombok.Setter;

/**
 * A single row in the rendered fact table. Bean-style getters are required by
 * JasperReports' {@code JRBeanCollectionDataSource} (it reflects on {@code getX}).
 * Kept deliberately simple/non-null so PDF, XLSX and CSV exports never NPE.
 */
@Getter
@Setter
public class FactRow {

    /** 1-based display sequence number. */
    private int seq;

    /** Region name. */
    private String region;

    /** Allocated amount in THB. */
    private double amount;

    public FactRow() {
    }

    public FactRow(int seq, String region, double amount) {
        this.seq = seq;
        this.region = region == null ? "" : region;
        this.amount = amount;
    }
}
