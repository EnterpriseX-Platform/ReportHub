package io.reporthub.reportstudio.service;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.domain.Datasource;
import io.reporthub.reportstudio.repo.DatasourceRepository;
import io.reporthub.reportstudio.web.BadRequestException;

import java.sql.Connection;
import java.sql.DriverManager;

/**
 * Resolves a datasourceId to a live JDBC {@link Connection} — the datasource's configured
 * external database (PostgreSQL/Oracle) when it has a JDBC URL, or the internal warehouse when
 * no datasource is selected. Shared by the Repository (table browser) and Schedulers features.
 *
 * <p>An explicitly selected datasource MUST have a usable JDBC connection: we never silently fall
 * back to the internal Postgres warehouse for it, because running an Oracle statement there yields
 * a misleading "relation ... does not exist" error.
 */
@Component
public class DbConnections {

    public interface SqlWork<T> { T run(Connection con) throws Exception; }

    private final DatasourceRepository datasources;
    private final JdbcTemplate internalJdbc;

    public DbConnections(DatasourceRepository datasources, JdbcTemplate internalJdbc) {
        this.datasources = datasources;
        this.internalJdbc = internalJdbc;
    }

    /** The configured datasource (validated), or null for the internal warehouse. */
    public Datasource resolve(String datasourceId) {
        if (datasourceId == null || datasourceId.isBlank()) return null;
        Datasource ds = datasources.findById(datasourceId)
                .orElseThrow(() -> new BadRequestException("Datasource not found: " + datasourceId));
        if (ds.getJdbcUrl() == null || ds.getJdbcUrl().isBlank()) {
            throw new BadRequestException("Datasource '" + ds.getName()
                    + "' has no JDBC connection configured — set its JDBC URL and credentials on the Datasources page");
        }
        return ds;
    }

    /**
     * Open a raw connection the caller is responsible for closing. Use when two connections must be
     * held at once (e.g. the warehouse ETL reads from a source while writing to a target).
     */
    public Connection open(String datasourceId, boolean readOnly) throws java.sql.SQLException {
        Datasource ds = resolve(datasourceId);
        Connection con;
        if (ds != null) {
            DriverManager.setLoginTimeout(8);
            con = DriverManager.getConnection(ds.getJdbcUrl(), ds.getDbUser(), ds.getDbPassword());
        } else {
            con = internalJdbc.getDataSource().getConnection();
        }
        try { con.setReadOnly(readOnly); } catch (Exception ignored) { /* pool may pin it */ }
        return con;
    }

    public boolean isOracle(String datasourceId) {
        Datasource ds = (datasourceId == null || datasourceId.isBlank()) ? null
                : datasources.findById(datasourceId).orElse(null);
        return ds != null && ds.getJdbcUrl() != null && ds.getJdbcUrl().startsWith("jdbc:oracle");
    }

    public <T> T withConnection(String datasourceId, boolean readOnly, SqlWork<T> work) {
        Datasource ds = resolve(datasourceId);
        try {
            if (ds != null) {
                DriverManager.setLoginTimeout(8);
                try (Connection con = DriverManager.getConnection(ds.getJdbcUrl(), ds.getDbUser(), ds.getDbPassword())) {
                    con.setReadOnly(readOnly);
                    return work.run(con);
                }
            }
            try (Connection con = internalJdbc.getDataSource().getConnection()) {
                boolean ro = con.isReadOnly();
                if (ro != readOnly) {
                    try { con.setReadOnly(readOnly); } catch (Exception ignored) { /* pool may pin it */ }
                }
                return work.run(con);
            }
        } catch (BadRequestException be) {
            throw be;
        } catch (Exception e) {
            throw new BadRequestException("Query failed: " + e.getMessage());
        }
    }
}
