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
 * A reusable runtime-parameter definition. Options come either from a static JSON list
 * ({@code source_type=static}) or a whitelisted lookup table ({@code source_type=query}).
 * {@code dependsOn}+{@code filterColumn} cascade the options off a parent parameter's value
 * (e.g. branchCode depends on regionCode).
 */
@Entity
@Table(name = "param_def")
@Getter
@Setter
public class ParamDef {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String name;

    @Column(name = "label", nullable = false)
    private String label;

    @Column(nullable = false)
    private String type;

    @Column(nullable = false)
    private boolean required;

    @Column(name = "default_value")
    private String defaultValue;

    @Column(name = "source_type", nullable = false)
    private String sourceType;

    @Column(name = "options_json")
    private String optionsJson;

    @Column(name = "lookup_table")
    private String lookupTable;

    @Column(name = "value_column")
    private String valueColumn;

    @Column(name = "label_column")
    private String labelColumn;

    @Column(name = "source_sql")
    private String sourceSql;

    @Column(name = "datasource_id")
    private String datasourceId;

    @Column(name = "depends_on")
    private String dependsOn;

    @Column(name = "filter_column")
    private String filterColumn;

    @Column(name = "sort_order", nullable = false)
    private int sortOrder;
}
