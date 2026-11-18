package io.reporthub.reportstudio.service;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Datasource;
import io.reporthub.reportstudio.domain.Report;
import io.reporthub.reportstudio.domain.ReportVersion;
import io.reporthub.reportstudio.domain.ReportCategory;
import io.reporthub.reportstudio.dto.CreateReportRequest;
import io.reporthub.reportstudio.dto.PageResponse;
import io.reporthub.reportstudio.dto.ReportCodeNameDto;
import io.reporthub.reportstudio.dto.ReportDetailDto;
import io.reporthub.reportstudio.dto.ReportSummaryDto;
import io.reporthub.reportstudio.repo.DatasourceRepository;
import io.reporthub.reportstudio.repo.ReportRepository;
import io.reporthub.reportstudio.repo.ReportSpecs;
import io.reporthub.reportstudio.repo.ReportVersionRepository;
import io.reporthub.reportstudio.repo.ReportCategoryRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;

import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Collection;
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
    private final io.reporthub.reportstudio.repo.ReportUnitRepository units;
    private final io.reporthub.reportstudio.repo.ReportUnitFileRepository unitFiles;
    private final io.reporthub.reportstudio.repo.OutputFileRepository outputs;
    private final io.reporthub.reportstudio.storage.ObjectStorageService storage;

    /** Level-2 ACLs; optional so the service can be built without them in tests. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.acl.AclService acl;

    private void requireAcl(String code, String perm) {
        if (acl != null) acl.require("REPORT", code, perm);
    }

    private <T> Specification<T> and(Specification<T> a, Specification<T> b) {
        return a == null ? b : (b == null ? a : a.and(b));
    }

    public ReportService(ReportRepository reports,
                         ReportCategoryRepository categories,
                         DatasourceRepository datasources,
                         ReportVersionRepository versions,
                         io.reporthub.reportstudio.repo.ReportUnitRepository units,
                         io.reporthub.reportstudio.repo.ReportUnitFileRepository unitFiles,
                         io.reporthub.reportstudio.repo.OutputFileRepository outputs,
                         io.reporthub.reportstudio.storage.ObjectStorageService storage) {
        this.reports = reports;
        this.categories = categories;
        this.datasources = datasources;
        this.versions = versions;
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
        requireAcl(code, "edit");
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
        // Trim before anything looks at it. `code` is UNIQUE, so an untrimmed code does not
        // collide with its own trimmed twin — the registry then shows the same report twice
        // and the template objects land under a key with the space baked in
        // ("/templates/ SALES-01/..."). Config import is the usual source: the code comes
        // from a parsed file, not from someone typing it.
        String code = req.code() == null ? "" : req.code().trim();
        if (code.isEmpty()) {
            throw new BadRequestException("Report code is required");
        }
        if (reports.existsByCode(code)) {
            throw new BadRequestException("Report code already exists: " + code);
        }
        if (!categories.existsById(req.categoryId())) {
            throw new BadRequestException("Unknown category: " + req.categoryId());
        }
        Report r = new Report();
        r.setId("RPT-" + UUID.randomUUID().toString().substring(0, 8));
        r.setCode(code);
        r.setName(req.name());
        r.setCategoryId(req.categoryId());
        r.setEngine(validEngine(req.engine()));
        r.setFormats(String.join(",", validFormats(req.formats())));
        r.setStatus("draft");
        r.setDatasourceId(req.datasourceId());
        r.setTemplatePath(req.templatePath());
        r.setVersion("0.1.0");
        r.setOwnerUnit(requireOwnerUnit(req.ownerUnit()));
        r.setAvgMs(0);
        r.setRuns(0);
        r.setParamCount(req.paramCount() == null ? 0 : req.paramCount());
        r.setTestData(req.testData() != null && req.testData());
        applyRunSettings(r, req.priority(), req.timeoutMinutes(), req.queue());
        r.setUpdatedAt(OffsetDateTime.now());
        reports.save(r);

        ReportVersion v = new ReportVersion();
        v.setReportCode(r.getCode());
        v.setVersion("0.1.0");
        v.setChangeType("both");
        v.setNote(req.note() == null ? "Registered" : req.note());
        v.setCreatedBy(currentUser());
        v.setCurrent(true);
        versions.save(v);

        // No parameters are assigned by default — the register wizard (or a later edit on the
        // detail view) assigns exactly what the user selected; none selected = none assigned.

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

    /** Report lifecycle states (DB CHECK on report.status). */
    public static final java.util.Set<String> STATUSES = java.util.Set.of("active", "testing", "draft", "error");

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.engine.EngineRegistry engineRegistry;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.repo.EngineInstanceRepository engineInstances;

    /** Apply non-null run settings, validating each. */
    static void applyRunSettings(Report r, String priority, Integer timeoutMinutes, String queue) {
        if (priority != null && !priority.isBlank()) r.setPriority(validPriority(priority));
        if (timeoutMinutes != null) {
            if (timeoutMinutes < 0 || timeoutMinutes > 1440) {
                throw new BadRequestException("timeoutMinutes must be between 1 and 1440 (0 = global limit)");
            }
            r.setTimeoutMinutes(timeoutMinutes == 0 ? null : timeoutMinutes);
        }
        if (queue != null) {
            String q = queue.trim();
            if (q.length() > 64) throw new BadRequestException("queue is too long (max 64)");
            r.setQueue(q.isEmpty() ? null : q);
        }
    }

    public static String validPriority(String priority) {
        String p = priority.trim().toLowerCase(java.util.Locale.ROOT);
        if (!p.equals("high") && !p.equals("normal") && !p.equals("low")) {
            throw new BadRequestException("priority must be high, normal or low");
        }
        return p;
    }

    /** Output formats a report may declare. */
    public static final java.util.Set<String> FORMATS = java.util.Set.of("PDF", "XLSX", "XLS", "DOCX", "CSV", "TXT", "HTML", "JSON", "ZIP");

    static List<String> validFormats(List<String> formats) {
        if (formats == null || formats.isEmpty()) throw new BadRequestException("At least one format is required");
        List<String> out = new java.util.ArrayList<>();
        for (String f : formats) {
            String v = f == null ? "" : f.trim().toUpperCase(java.util.Locale.ROOT);
            if (!FORMATS.contains(v)) {
                throw new BadRequestException("Unknown format '" + f + "'. Allowed: " + String.join(", ", new java.util.TreeSet<>(FORMATS)));
            }
            if (!out.contains(v)) out.add(v);
        }
        return out;
    }

    static String requireOwnerUnit(String ownerUnit) {
        if (ownerUnit == null || ownerUnit.isBlank()) throw new BadRequestException("Owner unit is required");
        return ownerUnit.trim();
    }

    /** {@code GET /reports?status=} value: one of {@link #STATUSES}, else 400. */
    public static String checkStatusFilter(String status) {
        return validStatus(status);
    }

    static String validStatus(String status) {
        String s = status.trim().toLowerCase(java.util.Locale.ROOT);
        if (!STATUSES.contains(s)) {
            throw new BadRequestException("Invalid status '" + status + "'. Allowed: active, testing, draft, error");
        }
        return s;
    }

    /** Engine kind must be installed (built-in/plugin) or configured as a remote engine instance. */
    String validEngine(String engine) {
        String e = engine == null ? "" : engine.trim();
        if (!e.matches("[A-Za-z0-9_.-]{1,32}")) {
            throw new BadRequestException("Invalid engine '" + engine + "'");
        }
        boolean known = engineRegistry == null
                || engineRegistry.has(e)
                || java.util.Set.of("composite", "query", "csv").contains(e)   // legacy kinds handled by the resolver
                || (engineInstances != null && engineInstances.findFirstByKindAndEnabledTrue(e).isPresent());
        if (!known) {
            throw new BadRequestException("Unknown engine '" + engine + "'. Installed: "
                    + String.join(", ", engineRegistry.availableKinds()));
        }
        return e;
    }

    private static String currentUser() {
        var a = org.springframework.security.core.context.SecurityContextHolder.getContext().getAuthentication();
        return a == null || a.getName() == null || "anonymousUser".equals(a.getName()) ? "system" : a.getName();
    }

    /** Config-screen save: apply non-null fields, bump minor version, append a version entry. */
    @Transactional
    public ReportDetailDto update(String code, io.reporthub.reportstudio.dto.UpdateReportRequest req, String by) {
        requireAcl(code, "edit");
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
        if (req.engine() != null && !req.engine().isBlank()) r.setEngine(validEngine(req.engine()));
        if (req.formats() != null && !req.formats().isEmpty()) r.setFormats(String.join(",", validFormats(req.formats())));
        if (req.status() != null && !req.status().isBlank()) r.setStatus(validStatus(req.status()));
        if (req.datasourceId() != null) r.setDatasourceId(req.datasourceId().isBlank() ? null : req.datasourceId());
        if (req.templatePath() != null) r.setTemplatePath(req.templatePath());
        if (req.ownerUnit() != null) r.setOwnerUnit(requireOwnerUnit(req.ownerUnit()));
        if (req.configJson() != null) r.setConfigJson(req.configJson().isBlank() ? null : req.configJson());
        if (req.outputFolder() != null) r.setOutputFolder(req.outputFolder().isBlank() ? null : req.outputFolder().trim());
        if (req.testData() != null) r.setTestData(req.testData());
        applyRunSettings(r, req.priority(), req.timeoutMinutes(), req.queue());
        // "" clears the restriction (report goes back to visible for everyone)
        if (req.allowedRoles() != null) {
            r.setAllowedRoles(req.allowedRoles().isBlank() ? null : req.allowedRoles().trim());
            syncAllowedRoles(code, r.getAllowedRoles(), by);
        }

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

    /**
     * @param portalRoles identity-provider role codes of a caller who came through the portal, or
     *                  null for a caller with no portal identity (direct admin/analyst
     *                  login). Null means no visibility predicate at all, so the direct
     *                  login keeps seeing the whole registry.
     */
    public PageResponse<ReportSummaryDto> search(String category, String status, String engine,
                                                 String datasource, String q,
                                                 Collection<String> portalRoles, Pageable pageable) {
        Map<String, ReportCategory> catMap = categoryMap();
        Map<String, Datasource> dsMap = datasourceMap();
        Specification<Report> spec = ReportSpecs.search(blankToNull(category), blankToNull(status),
                blankToNull(engine), blankToNull(datasource), blankToNull(q));
        // Visibility = object ACL (acl_entry, which absorbed the old allowed_roles CSV). Portal callers'
        // role codes are their principal roles, so the old portal filter is covered by this.
        if (acl != null) spec = and(spec, acl.visible("REPORT", "code", "view"));
        else if (portalRoles != null) spec = and(spec, ReportSpecs.visibleTo(portalRoles));
        Page<Report> page = reports.findAll(spec, pageable);
        return PageResponse.of(page, r -> toSummary(r, catMap, dsMap));
    }

    /**
     * The whole registry as {code, name} pairs, ordered by code — what another app needs to fill
     * a report picker. Unpaged on purpose: the registry is a few hundred rows and the caller wants
     * one round trip, not a page walk.
     *
     * @param portalRoles as in {@link #search} — a portal caller only sees what their portal roles
     *                  allow, so this list cannot be used to enumerate restricted reports.
     */
    public List<ReportCodeNameDto> codeList(Collection<String> portalRoles) {
        Specification<Report> spec = acl != null ? acl.visible("REPORT", "code", "view")
                : (portalRoles == null ? null : ReportSpecs.visibleTo(portalRoles));
        return reports.findAll(spec, Sort.by(Sort.Direction.ASC, "code")).stream()
                .map(r -> new ReportCodeNameDto(r.getCode(), r.getName()))
                .toList();
    }

    public ReportDetailDto getByCode(String code) {
        requireAcl(code, "view");
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
                r.getAvgMs(), r.getRuns(), r.getParamCount(), r.getConfigJson(), r.getOutputFolder(),
                r.isTestData(), r.getAllowedRoles(), r.getUpdatedAt(),
                r.getPriority(), r.getTimeoutMinutes(), r.getQueue());
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

    /**
     * The legacy {@code allowedRoles} CSV maps to role→run ACL grants: grants for roles no longer in
     * the list are dropped, new roles are added; user/responsibility grants are left alone.
     */
    private void syncAllowedRoles(String code, String csv, String by) {
        if (acl == null) return;
        java.util.Set<String> want = new java.util.LinkedHashSet<>();
        if (csv != null) for (String c : csv.split(",")) if (!c.isBlank()) want.add(c.trim());
        List<io.reporthub.reportstudio.acl.AclRules.Grant> keep = new java.util.ArrayList<>();
        for (var e : acl.list("REPORT", code)) {
            boolean roleRun = "role".equals(e.getPrincipalType()) && "run".equals(e.getPermission());
            if (!roleRun || want.remove(e.getPrincipalCode())) keep.add(io.reporthub.reportstudio.acl.AclService.grant(e));
        }
        for (String role : want) keep.add(new io.reporthub.reportstudio.acl.AclRules.Grant("role", role, "run"));
        acl.replace("REPORT", code, keep, by);
    }
}
