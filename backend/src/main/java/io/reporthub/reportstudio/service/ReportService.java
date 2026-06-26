package io.reporthub.reportstudio.service;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Datasource;
import io.reporthub.reportstudio.domain.Report;
import io.reporthub.reportstudio.domain.ReportVersion;
import io.reporthub.reportstudio.domain.ReportCategory;
import io.reporthub.reportstudio.dto.CreateReportRequest;
import io.reporthub.reportstudio.dto.PageResponse;
import io.reporthub.reportstudio.dto.ReportDetailDto;
import io.reporthub.reportstudio.dto.ReportSummaryDto;
import io.reporthub.reportstudio.repo.DatasourceRepository;
import io.reporthub.reportstudio.repo.ReportRepository;
import io.reporthub.reportstudio.repo.ReportVersionRepository;
import io.reporthub.reportstudio.repo.ReportCategoryRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;

import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

@Service
@Transactional(readOnly = true)
public class ReportService {

    private final ReportRepository reports;
    private final ReportCategoryRepository categories;
    private final DatasourceRepository datasources;
    private final ReportVersionRepository versions;
    private final ParameterService parameters;
    private final io.reporthub.reportstudio.repo.ReportUnitRepository units;
    private final io.reporthub.reportstudio.repo.ReportUnitFileRepository unitFiles;
    private final io.reporthub.reportstudio.repo.OutputFileRepository outputs;
    private final io.reporthub.reportstudio.storage.ObjectStorageService storage;

    public ReportService(ReportRepository reports,
                         ReportCategoryRepository categories,
                         DatasourceRepository datasources,
                         ReportVersionRepository versions,
                         ParameterService parameters,
                         io.reporthub.reportstudio.repo.ReportUnitRepository units,
                         io.reporthub.reportstudio.repo.ReportUnitFileRepository unitFiles,
                         io.reporthub.reportstudio.repo.OutputFileRepository outputs,
                         io.reporthub.reportstudio.storage.ObjectStorageService storage) {
        this.reports = reports;
        this.categories = categories;
        this.datasources = datasources;
        this.versions = versions;
        this.parameters = parameters;
        this.units = units;
        this.unitFiles = unitFiles;
        this.outputs = outputs;
        this.storage = storage;
    }

    /**
     * Delete a report and everything under it. The DB FKs are ON DELETE CASCADE, so removing the
     * report row also removes its units, unit files, params, versions and flow rows; we clean up the
     * uploaded template objects AND the generated output files (DB rows + MinIO objects) ourselves.
     */
    @Transactional
    public void delete(String code) {
        Report r = reports.findByCode(code)
                .orElseThrow(() -> new NotFoundException("Report not found: " + code));
        // Uploaded template objects (MinIO) — the unit_file rows themselves cascade with the report.
        for (var unit : units.findByReportCodeOrderBySortOrderAscIdAsc(code)) {
            for (var f : unitFiles.findByUnitIdOrderByRoleAscUploadedAtDesc(unit.getId())) {
                storage.delete(f.getObjectKey());
            }
        }
        // Generated output files (no FK to report) — remove MinIO objects then the rows.
        var outs = outputs.findByReportCode(code);
        for (var o : outs) {
            storage.delete(o.getObjectKey());
        }
        outputs.deleteAll(outs);
        reports.delete(r);
    }

    @Transactional
    public ReportDetailDto create(CreateReportRequest req) {
        if (reports.existsByCode(req.code())) {
            throw new BadRequestException("Report code already exists: " + req.code());
        }
        if (!categories.existsById(req.categoryId())) {
            throw new BadRequestException("Unknown category: " + req.categoryId());
        }
        Report r = new Report();
        r.setId("RPT-" + UUID.randomUUID().toString().substring(0, 8));
        r.setCode(req.code());
        r.setName(req.name());
        r.setCategoryId(req.categoryId());
        r.setEngine(req.engine());
        r.setFormats(String.join(",", req.formats()));
        r.setStatus("draft");
        r.setDatasourceId(req.datasourceId());
        r.setTemplatePath(req.templatePath());
        r.setVersion("0.1.0");
        r.setOwnerUnit(req.ownerUnit());
        r.setAvgMs(0);
        r.setRuns(0);
        r.setParamCount(req.paramCount() == null ? 0 : req.paramCount());
        r.setUpdatedAt(OffsetDateTime.now());
        reports.save(r);

        ReportVersion v = new ReportVersion();
        v.setReportCode(r.getCode());
        v.setVersion("0.1.0");
        v.setChangeType("both");
        v.setNote(req.note() == null ? "Registered" : req.note());
        v.setCreatedBy(req.ownerUnit() == null ? "system" : req.ownerUnit());
        v.setCurrent(true);
        versions.save(v);

        parameters.assignDefaults(r.getCode());

        // Every report starts with a default render unit — the unit set IS the definition.
        io.reporthub.reportstudio.domain.ReportUnit unit = new io.reporthub.reportstudio.domain.ReportUnit();
        unit.setReportCode(r.getCode());
        unit.setName("default");
        unit.setEngine(r.getEngine());
        unit.setSortOrder(1);
        unit.setEnabled(true);
        unit.setCreatedAt(OffsetDateTime.now());
        units.save(unit);

        return getByCode(r.getCode());
    }

    /** Config-screen save: apply non-null fields, bump minor version, append a version entry. */
    @Transactional
    public ReportDetailDto update(String code, io.reporthub.reportstudio.dto.UpdateReportRequest req, String by) {
        Report r = reports.findByCode(code)
                .orElseThrow(() -> new NotFoundException("Report not found: " + code));
        if (req.categoryId() != null && !categories.existsById(req.categoryId())) {
            throw new BadRequestException("Unknown category: " + req.categoryId());
        }
        if (req.datasourceId() != null && !req.datasourceId().isBlank()
                && !datasources.existsById(req.datasourceId())) {
            throw new BadRequestException("Unknown datasource: " + req.datasourceId());
        }
        if (req.name() != null && !req.name().isBlank()) r.setName(req.name());
        if (req.categoryId() != null) r.setCategoryId(req.categoryId());
        if (req.engine() != null && !req.engine().isBlank()) r.setEngine(req.engine());
        if (req.formats() != null && !req.formats().isEmpty()) r.setFormats(String.join(",", req.formats()));
        if (req.status() != null && !req.status().isBlank()) r.setStatus(req.status());
        if (req.datasourceId() != null) r.setDatasourceId(req.datasourceId().isBlank() ? null : req.datasourceId());
        if (req.templatePath() != null) r.setTemplatePath(req.templatePath());
        if (req.ownerUnit() != null) r.setOwnerUnit(req.ownerUnit());
        if (req.configJson() != null) r.setConfigJson(req.configJson().isBlank() ? null : req.configJson());
        if (req.outputFolder() != null) r.setOutputFolder(req.outputFolder().isBlank() ? null : req.outputFolder().trim());

        String next = bumpMinor(r.getVersion());
        r.setVersion(next);
        r.setUpdatedAt(OffsetDateTime.now());
        reports.save(r);

        versions.findByReportCodeOrderByCreatedAtDesc(code).forEach(old -> {
            if (old.isCurrent()) { old.setCurrent(false); versions.save(old); }
        });
        ReportVersion v = new ReportVersion();
        v.setReportCode(code);
        v.setVersion(next);
        v.setChangeType("config");
        v.setNote(req.note() == null || req.note().isBlank() ? "Edited via the config screen" : req.note());
        v.setCreatedBy(by == null ? "system" : by);
        v.setCreatedAt(OffsetDateTime.now());
        v.setCurrent(true);
        versions.save(v);

        return getByCode(code);
    }

    public List<io.reporthub.reportstudio.dto.VersionDto> versionsOf(String code) {
        reports.findByCode(code).orElseThrow(() -> new NotFoundException("Report not found: " + code));
        return versions.findByReportCodeOrderByCreatedAtDesc(code).stream()
                .map(v -> new io.reporthub.reportstudio.dto.VersionDto(
                        v.getId(), v.getVersion(), v.getChangeType(), v.getNote(),
                        v.getCreatedBy(), v.getCreatedAt(), v.isCurrent()))
                .toList();
    }

    private static String bumpMinor(String version) {
        try {
            String[] p = version.split("\\.");
            return p[0] + "." + (Integer.parseInt(p[1]) + 1) + ".0";
        } catch (Exception e) {
            return version + ".1";
        }
    }

    public PageResponse<ReportSummaryDto> search(String category, String status, String engine,
                                                 String datasource, String q, Pageable pageable) {
        Map<String, ReportCategory> catMap = categoryMap();
        Map<String, Datasource> dsMap = datasourceMap();
        Page<Report> page = reports.search(blankToNull(category), blankToNull(status),
                blankToNull(engine), blankToNull(datasource), blankToNull(q), pageable);
        return PageResponse.of(page, r -> toSummary(r, catMap, dsMap));
    }

    public ReportDetailDto getByCode(String code) {
        Report r = reports.findByCode(code)
                .orElseThrow(() -> new NotFoundException("Report not found: " + code));
        ReportCategory cat = categoryMap().get(r.getCategoryId());
        Datasource ds = r.getDatasourceId() == null ? null : datasourceMap().get(r.getDatasourceId());
        return new ReportDetailDto(
                r.getId(), r.getCode(), r.getName(),
                r.getCategoryId(), cat == null ? null : cat.getRef(), cat == null ? null : cat.getName(),
                r.getEngine(), splitFormats(r.getFormats()), r.getStatus(),
                r.getDatasourceId(), ds == null ? null : ds.getName(),
                r.getTemplatePath(), r.getVersion(), r.getOwnerUnit(),
                r.getAvgMs(), r.getRuns(), r.getParamCount(), r.getConfigJson(), r.getOutputFolder(), r.getUpdatedAt());
    }

    // --- mapping helpers -----------------------------------------------------

    public ReportSummaryDto toSummary(Report r, Map<String, ReportCategory> catMap, Map<String, Datasource> dsMap) {
        ReportCategory cat = catMap.get(r.getCategoryId());
        Datasource ds = r.getDatasourceId() == null ? null : dsMap.get(r.getDatasourceId());
        return new ReportSummaryDto(
                r.getId(), r.getCode(), r.getName(),
                r.getCategoryId(), cat == null ? null : cat.getRef(),
                r.getEngine(), splitFormats(r.getFormats()), r.getStatus(),
                r.getDatasourceId(), ds == null ? null : ds.getName(),
                r.getVersion(), r.getAvgMs(), r.getRuns(), r.getUpdatedAt());
    }

    public Map<String, ReportCategory> categoryMap() {
        return categories.findAll().stream()
                .collect(Collectors.toMap(ReportCategory::getId, Function.identity()));
    }

    public Map<String, Datasource> datasourceMap() {
        return datasources.findAll().stream()
                .collect(Collectors.toMap(Datasource::getId, Function.identity()));
    }

    static List<String> splitFormats(String csv) {
        if (csv == null || csv.isBlank()) return List.of();
        return Arrays.stream(csv.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }
}
