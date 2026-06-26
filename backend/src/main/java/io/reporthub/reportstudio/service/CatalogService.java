package io.reporthub.reportstudio.service;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Datasource;
import io.reporthub.reportstudio.dto.CategoryDto;
import io.reporthub.reportstudio.dto.DatasourceDto;
import io.reporthub.reportstudio.repo.DatasourceRepository;
import io.reporthub.reportstudio.repo.ReportRepository;
import io.reporthub.reportstudio.repo.ReportCategoryRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.CatalogController;
import io.reporthub.reportstudio.web.NotFoundException;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
@Transactional(readOnly = true)
public class CatalogService {

    private final ReportCategoryRepository categories;
    private final DatasourceRepository datasources;
    private final ReportRepository reports;
    private final JdbcTemplate jdbc;

    public CatalogService(ReportCategoryRepository categories,
                          DatasourceRepository datasources,
                          ReportRepository reports,
                          JdbcTemplate jdbc) {
        this.categories = categories;
        this.datasources = datasources;
        this.reports = reports;
        this.jdbc = jdbc;
    }

    public List<CategoryDto> categories() {
        Map<String, Long> counts = reports.countByCategory().stream()
                .collect(Collectors.toMap(
                        ReportRepository.CategoryCount::getCategoryId,
                        ReportRepository.CategoryCount::getCount));
        return categories.findAllByOrderBySortOrderAsc().stream()
                .map(c -> new CategoryDto(c.getId(), c.getRef(), c.getName(),
                        c.getMinReports(), counts.getOrDefault(c.getId(), 0L)))
                .toList();
    }

    public List<DatasourceDto> datasources() {
        return datasources.findAllByOrderByNameAsc().stream()
                .map(d -> new DatasourceDto(d.getId(), d.getName(), d.getEngine(), d.getHost(),
                        d.getSchemaName(), d.getStatus(), d.getLatencyMs(), d.getPool(),
                        reports.countByDatasourceId(d.getId()),
                        d.getJdbcUrl() != null && !d.getJdbcUrl().isBlank()))
                .toList();
    }

    @Transactional
    public DatasourceDto createDatasource(CatalogController.CreateDatasourceRequest req) {
        if (datasources.existsById(req.id())) {
            throw new BadRequestException("Datasource id already exists: " + req.id());
        }
        Datasource d = new Datasource();
        d.setId(req.id());
        d.setName(req.name());
        d.setEngine(req.engine());
        d.setHost(req.host());
        d.setSchemaName(req.schemaName());
        d.setStatus("healthy");
        d.setLatencyMs(0);
        d.setPool(req.pool() == null ? "0 / 10" : req.pool());
        d.setJdbcUrl(blank(req.jdbcUrl()));
        d.setDbUser(blank(req.dbUser()));
        d.setDbPassword(blank(req.dbPassword()));
        datasources.save(d);
        return new DatasourceDto(d.getId(), d.getName(), d.getEngine(), d.getHost(),
                d.getSchemaName(), d.getStatus(), d.getLatencyMs(), d.getPool(), 0,
                d.getJdbcUrl() != null);
    }

    private static String blank(String s) { return (s == null || s.isBlank()) ? null : s.trim(); }

    public record DsTestResult(boolean ok, long latencyMs, String status, String message) {}

    /**
     * Real connectivity probe. REST endpoints get an HTTP HEAD with a short timeout;
     * database engines are measured against the warehouse this instance actually serves
     * (SIT backs every dataset with the internal Postgres). Result is persisted on the row.
     */
    @Transactional
    public DsTestResult testDatasource(String id) {
        Datasource d = datasources.findById(id)
                .orElseThrow(() -> new NotFoundException("Datasource not found: " + id));

        DsTestResult result;
        if (d.getJdbcUrl() != null && !d.getJdbcUrl().isBlank()) {
            // REAL connection to the configured database (PostgreSQL / Oracle drivers on classpath).
            result = probeJdbc(d.getJdbcUrl(), d.getDbUser(), d.getDbPassword());
        } else if (d.getEngine() != null && d.getEngine().toUpperCase().contains("REST")) {
            result = probeHttp(d.getHost());
        } else {
            long t0 = System.nanoTime();
            try {
                jdbc.queryForObject("SELECT 1", Integer.class);
                long ms = Math.max(1, (System.nanoTime() - t0) / 1_000_000);
                result = new DsTestResult(true, ms, "healthy",
                        "SELECT 1 OK · " + ms + " ms (SIT warehouse)");
            } catch (Exception e) {
                result = new DsTestResult(false, 0, "down", "JDBC probe failed: " + e.getMessage());
            }
        }
        d.setStatus(result.status());
        if (result.ok()) d.setLatencyMs((int) result.latencyMs());
        datasources.save(d);
        return result;
    }

    private static DsTestResult probeJdbc(String url, String user, String pass) {
        java.sql.DriverManager.setLoginTimeout(5);
        long t0 = System.nanoTime();
        try (java.sql.Connection c = java.sql.DriverManager.getConnection(url, user, pass);
             java.sql.Statement st = c.createStatement()) {
            String probe = url.startsWith("jdbc:oracle") ? "SELECT 1 FROM DUAL" : "SELECT 1";
            st.execute(probe);
            long ms = Math.max(1, (System.nanoTime() - t0) / 1_000_000);
            return new DsTestResult(true, ms, ms > 800 ? "degraded" : "healthy",
                    "Connected · " + probe + " OK · " + ms + " ms");
        } catch (Exception e) {
            return new DsTestResult(false, 0, "down", "Connect failed: " + e.getMessage());
        }
    }

    private static DsTestResult probeHttp(String host) {
        if (host == null || host.isBlank()) {
            return new DsTestResult(false, 0, "down", "No host configured");
        }
        String url = host.startsWith("http") ? host : "https://" + host;
        try {
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(3)).build();
            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .method("HEAD", HttpRequest.BodyPublishers.noBody())
                    .timeout(Duration.ofSeconds(4)).build();
            long t0 = System.nanoTime();
            HttpResponse<Void> res = client.send(req, HttpResponse.BodyHandlers.discarding());
            long ms = Math.max(1, (System.nanoTime() - t0) / 1_000_000);
            boolean ok = res.statusCode() < 500;
            return new DsTestResult(ok, ms, ok ? (ms > 500 ? "degraded" : "healthy") : "down",
                    "HTTP " + res.statusCode() + " · " + ms + " ms");
        } catch (Exception e) {
            return new DsTestResult(false, 0, "down", "Unreachable: " + e.getMessage());
        }
    }
}
