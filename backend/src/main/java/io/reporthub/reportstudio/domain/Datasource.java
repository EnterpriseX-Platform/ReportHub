package io.reporthub.reportstudio.domain;

import io.reporthub.reportstudio.tenancy.TenantScoped;
import org.hibernate.annotations.Filter;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

/** A datasource connection (Oracle / PostgreSQL / external system API / …). */
@Entity
@Filter(name = TenantScoped.FILTER)
@Table(name = "datasource")
@Getter
@Setter
public class Datasource extends TenantScoped {

    @Id
    private String id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private String engine;

    private String host;

    @Column(name = "schema_name")
    private String schemaName;

    @Column(nullable = false)
    private String status;

    @Column(name = "latency_ms")
    private Integer latencyMs;

    private String pool;


    /** Real JDBC connection (PostgreSQL/Oracle). Password is write-only via the API. */
    @Column(name = "jdbc_url")
    private String jdbcUrl;

    @Column(name = "db_user")
    private String dbUser;

    @Column(name = "db_password")
    @jakarta.persistence.Convert(converter = io.reporthub.reportstudio.security.AuthTokenConverter.class)
    private String dbPassword;

    /** At most one datasource is the default; enforced in CatalogService.setDefault. */
    @Column(name = "is_default", nullable = false)
    private boolean isDefault;
}
