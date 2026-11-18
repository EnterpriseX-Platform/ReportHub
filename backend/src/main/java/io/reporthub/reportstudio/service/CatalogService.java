package io.reporthub.reportstudio.service;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Datasource;
import io.reporthub.reportstudio.dto.CategoryDto;
import io.reporthub.reportstudio.domain.ReportCategory;
import io.reporthub.reportstudio.web.ConflictException;
import io.reporthub.reportstudio.dto.DatasourceDto;
import io.reporthub.reportstudio.repo.DatasetDefRepository;
import io.reporthub.reportstudio.repo.DatasourceRepository;
import io.reporthub.reportstudio.repo.ParamDefRepository;
import io.reporthub.reportstudio.repo.ReportRepository;
import io.reporthub.reportstudio.repo.ReportUnitRepository;
import io.reporthub.reportstudio.repo.SchedulerRepository;
import io.reporthub.reportstudio.repo.ReportCategoryRepository;
import io.reporthub.reportstudio.repo.WarehousePipelineRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.CatalogController;
import io.reporthub.reportstudio.web.NotFoundException;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
@Transactional(readOnly = true)
public class CatalogService {

    private final ReportCategoryRepository categories;
    private final DatasourceRepository datasources;
    private final ReportRepository reports;
    private final ReportUnitRepository reportUnits;
    private final DatasetDefRepository datasets;
    private final ParamDefRepository params;
    private final SchedulerRepository schedulers;
    private final WarehousePipelineRepository warehousePipelines;
    private final JdbcTemplate jdbc;

    public CatalogService(ReportCategoryRepository categories,
                          DatasourceRepository datasources,
                          ReportRepository reports,
                          ReportUnitRepository reportUnits,
                          DatasetDefRepository datasets,
                          ParamDefRepository params,
                          SchedulerRepository schedulers,
                          WarehousePipelineRepository warehousePipelines,
                          JdbcTemplate jdbc) {
        this.categories = categories;
        this.datasources = datasources;
        this.reports = reports;
        this.reportUnits = reportUnits;
        this.datasets = datasets;
        this.params = params;
        this.schedulers = schedulers;
        this.warehousePipelines = warehousePipelines;
        this.jdbc = jdbc;
    }

    public List<CategoryDto> categories() {
        Map<String, Long> counts = reports.countByCategory().stream()
                .collect(Collectors.toMap(
                        ReportRepository.CategoryCount::getCategoryId,
                        ReportRepository.CategoryCount::getCount));
        return categories.findAllByOrderBySortOrderAsc().stream()
                .map(c -> toDto(c, counts.getOrDefault(c.getId(), 0L)))
                .toList();
    }

    private static CategoryDto toDto(ReportCategory c, long registered) {
        return new CategoryDto(c.getId(), c.getRef(), c.getName(), c.getMinReports(), registered,
                c.getDescription(), c.getSortOrder());
    }

    /** Category ids: lower-case letters, digits, '-' and '_' (column is VARCHAR(16)). */
    static String categoryId(String requested, String name) {
        String id = requested == null || requested.isBlank()
                ? name.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("(^-+|-+$)", "")
                : requested.trim();
        if (id.isEmpty()) {
            id = "cat-" + Long.toString(System.currentTimeMillis() % 100000000L, 36);
        }
        if (id.length() > 16) id = id.substring(0, 16).replaceAll("-+$", "");
        if (!id.matches("[A-Za-z0-9_-]{1,16}")) {
            throw new BadRequestException("Category id must be 1-16 letters, digits, '-' or '_'");
        }
        return id;
    }

    @Transactional
    public CategoryDto createCategory(CategoryDto.Request req) {
        String name = requireName(req);
        String id = categoryId(req.id(), name);
        if (categories.existsById(id)) {
            if (req.id() != null && !req.id().isBlank()) {
                throw new ConflictException("Category id already exists: " + id);
            }
            String base = id.length() > 11 ? id.substring(0, 11) : id;
            int n = 2;
            while (categories.existsById(base + "-" + n)) n++;
            id = base + "-" + n;
        }
        ReportCategory c = new ReportCategory();
        c.setId(id);
        c.setRef(id.toUpperCase(java.util.Locale.ROOT));
        c.setName(name);
        c.setDescription(blank(req.description()));
        c.setMinReports(0);
        c.setSortOrder(req.sortOrder() == null ? 0 : req.sortOrder());
        categories.save(c);
        return toDto(c, 0);
    }

    @Transactional
    public CategoryDto updateCategory(String id, CategoryDto.Request req) {
        ReportCategory c = categories.findById(id)
                .orElseThrow(() -> new NotFoundException("Category not found: " + id));
        c.setName(requireName(req));
        c.setDescription(blank(req.description()));
        if (req.sortOrder() != null) c.setSortOrder(req.sortOrder());
        categories.save(c);
        return toDto(c, reports.countByCategoryId(id));
    }

    /** Delete a category — refused (409) while any report is still filed under it. */
    @Transactional
    public void deleteCategory(String id) {
        ReportCategory c = categories.findById(id)
                .orElseThrow(() -> new NotFoundException("Category not found: " + id));
        if (isDefaultCategory(c)) {
            throw new ConflictException("The default category \"" + c.getName() + "\" cannot be deleted");
        }
        long used = reports.countByCategoryId(id);
        if (used > 0) {
            throw new ConflictException("Cannot delete category - still used by " + used
                    + " report(s). Move them to another category first.");
        }
        categories.delete(c);
    }

    /** The seeded "General" category (ref GEN) every tenant/project starts with. */
    static boolean isDefaultCategory(ReportCategory c) {
        return "GEN".equalsIgnoreCase(c.getRef()) || "General".equalsIgnoreCase(c.getName() == null ? "" : c.getName().trim());
    }

    private static String requireName(CategoryDto.Request req) {
        if (req == null || req.name() == null || req.name().isBlank()) {
            throw new BadRequestException("Category name is required");
        }
        if (req.name().length() > 255) throw new BadRequestException("Category name is too long (max 255)");
        return req.name().trim();
    }

    public List<DatasourceDto> datasources() {
        return datasources.findAllByOrderByNameAsc().stream()
                .map(d -> new DatasourceDto(d.getId(), d.getName(), d.getEngine(), d.getHost(),
                        d.getSchemaName(), d.getStatus(), d.getLatencyMs(), d.getPool(),
                        reports.countByDatasourceId(d.getId()),
                        d.getJdbcUrl() != null && !d.getJdbcUrl().isBlank(),
                        d.isDefault(),
                        !usageBreakdown(d.getId()).isEmpty()))
                .toList();
    }

    /**
     * Everywhere a datasource can be referenced. Returns a human-readable breakdown (empty = unused),
     * used both to flag {@code inUse} in the list and to explain a refused delete. Job history is
     * intentionally excluded — those are past run records, not a live configuration reference.
     */
    private List<String> usageBreakdown(String id) {
        List<String> used = new ArrayList<>();
        long r = reports.countByDatasourceId(id);
        if (r > 0) used.add(r + " report(s)");
        long u = reportUnits.countByDatasourceId(id);
        if (u > 0) used.add(u + " render unit(s)");
        long ds = datasets.countByDatasourceId(id);
        if (ds > 0) used.add(ds + " dataset(s)");
        long p = params.countByDatasourceId(id);
        if (p > 0) used.add(p + " parameter(s)");
        long s = schedulers.countByDatasourceId(id);
        if (s > 0) used.add(s + " scheduler(s)");
        long w = warehousePipelines.countBySourceDatasourceIdOrTargetDatasourceId(id, id);
        if (w > 0) used.add(w + " warehouse pipeline(s)");
        long dc = countRefs("SELECT COUNT(*) FROM data_check WHERE datasource_id = ?", id);
        if (dc > 0) used.add(dc + " data check(s)");
        long cg = countRefs("SELECT COUNT(*) FROM check_group_scope WHERE datasource_id = ?", id);
        if (cg > 0) used.add(cg + " check group scope(s)");
        long rt = countRefs("SELECT COUNT(*) FROM repo_table WHERE datasource_id = ?", id);
        if (rt > 0) used.add(rt + " data table(s)");
        return used;
    }

    /** Count rows referencing a datasource; a missing table (older schema) counts as 0. */
    private long countRefs(String sql, String id) {
        try {
            Long n = jdbc.queryForObject(sql, Long.class, id);
            return n == null ? 0 : n;
        } catch (org.springframework.dao.DataAccessException e) {
            return 0;
        }
    }

    /** Make {@code id} the single default datasource, clearing the flag on every other row. */
    @Transactional
    public void setDefault(String id) {
        if (!datasources.existsById(id)) {
            throw new NotFoundException("Datasource not found: " + id);
        }
        for (Datasource d : datasources.findAll()) {
            boolean shouldBeDefault = d.getId().equals(id);
            if (d.isDefault() != shouldBeDefault) {
                d.setDefault(shouldBeDefault);
                datasources.save(d);
            }
        }
    }

    /**
     * Delete a datasource — refused while it is still referenced ANYWHERE (report, render unit,
     * dataset, parameter, scheduler, or warehouse pipeline). This both protects the FK constraints
     * and prevents silently orphaning the no-FK references (report_unit / param_def / job).
     */
    @Transactional
    public void delete(String id) {
        Datasource d = datasources.findById(id)
                .orElseThrow(() -> new NotFoundException("Datasource not found: " + id));
        List<String> used = usageBreakdown(id);
        if (!used.isEmpty()) {
            throw new BadRequestException("Cannot delete — still used by "
                    + String.join(", ", used) + ". Reassign or remove them first.");
        }
        datasources.delete(d);
    }

    @Transactional
    public DatasourceDto createDatasource(CatalogController.CreateDatasourceRequest req) {
        if (datasources.existsById(req.id())) {
            throw new BadRequestException("Datasource id already exists: " + req.id());
        }
        AppDatabaseGuard.checkDatasourceUrl(req.jdbcUrl());
        Datasource d = new Datasource();
        d.setId(req.id());
        d.setName(req.name());
        d.setEngine(normalizeEngine(req.engine()));
        d.setHost(req.host());
        d.setSchemaName(req.schemaName());
        d.setStatus("unknown");   // not probed yet — POST /datasources/{id}/test sets it
        d.setLatencyMs(0);
        d.setPool(req.pool() == null ? "0 / 10" : req.pool());
        d.setJdbcUrl(blank(req.jdbcUrl()));
        d.setDbUser(blank(req.dbUser()));
        d.setDbPassword(blank(req.dbPassword()));
        datasources.save(d);
        return new DatasourceDto(d.getId(), d.getName(), d.getEngine(), d.getHost(),
                d.getSchemaName(), d.getStatus(), d.getLatencyMs(), d.getPool(), 0,
                d.getJdbcUrl() != null, d.isDefault(), false);
    }

    @Transactional
    public DatasourceDto updateDatasource(String id, CatalogController.UpdateDatasourceRequest req) {
        Datasource d = datasources.findById(id)
                .orElseThrow(() -> new NotFoundException("Datasource not found: " + id));
        d.setName(req.name());
        d.setEngine(normalizeEngine(req.engine()));
        d.setHost(req.host());
        d.setSchemaName(req.schemaName());
        // jdbcUrl / dbUser / dbPassword are write-only — the list DTO never returns them, so the UI
        // cannot pre-fill them. A blank value therefore means "keep the stored one" (setting it to
        // null would silently wipe a working connection); only a non-blank value overwrites.
        String url = blank(req.jdbcUrl());
        AppDatabaseGuard.checkDatasourceUrl(url != null ? url : d.getJdbcUrl());
        if (url != null) d.setJdbcUrl(url);
        String user = blank(req.dbUser());
        if (user != null) d.setDbUser(user);
        String pw = blank(req.dbPassword());
        if (pw != null) d.setDbPassword(pw);
        datasources.save(d);
        return new DatasourceDto(d.getId(), d.getName(), d.getEngine(), d.getHost(),
                d.getSchemaName(), d.getStatus(), d.getLatencyMs(), d.getPool(),
                reports.countByDatasourceId(d.getId()),
                d.getJdbcUrl() != null && !d.getJdbcUrl().isBlank(),
                d.isDefault(),
                !usageBreakdown(d.getId()).isEmpty());
    }

    /** Canonical datasource engine names: POSTGRES, ORACLE, MYSQL, SQLSERVER, REST; others upper-cased. */
    static String normalizeEngine(String engine) {
        if (engine == null || engine.isBlank()) throw new BadRequestException("engine is required");
        String e = engine.trim().toLowerCase(java.util.Locale.ROOT);
        if (e.contains("postgres") || e.equals("pg") || e.equals("pgsql")) return "POSTGRES";
        if (e.contains("oracle")) return "ORACLE";
        if (e.contains("mysql") || e.contains("mariadb")) return "MYSQL";
        if (e.contains("sqlserver") || e.contains("sql server") || e.contains("mssql")) return "SQLSERVER";
        if (e.contains("rest") || e.contains("soap") || e.equals("api") || e.equals("http")) return "REST";
        return engine.trim().toUpperCase(java.util.Locale.ROOT);
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
        } else if (!d.isDefault()) {
            // No JDBC URL: nothing to connect to. Probing the app's own database here would report
            // a connection that was never configured as healthy.
            result = new DsTestResult(false, 0, "not_configured",
                    "Not configured · add a JDBC URL to test this connection");
        } else {
            long t0 = System.nanoTime();
            try {
                jdbc.queryForObject("SELECT 1", Integer.class);
                long ms = Math.max(1, (System.nanoTime() - t0) / 1_000_000);
                result = new DsTestResult(true, ms, "healthy",
                        "SELECT 1 OK · " + ms + " ms (application database)");
            } catch (Exception e) {
                result = new DsTestResult(false, 0, "down", "JDBC probe failed: " + e.getMessage());
            }
        }
        // "not_configured" is only a probe answer; the row keeps "unknown" (the status column's allowed values)
        d.setStatus("not_configured".equals(result.status()) ? "unknown" : result.status());
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
            return new DsTestResult(false, 0, "down", "Unreachable: " + (e.getMessage() != null ? e.getMessage() : e.getCause() != null && e.getCause().getMessage() != null ? e.getCause().getClass().getSimpleName() + ": " + e.getCause().getMessage() : e.getClass().getSimpleName()));
        }
    }
}
