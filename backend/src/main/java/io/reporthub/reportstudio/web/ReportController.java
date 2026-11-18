package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.dto.CreateReportRequest;
import io.reporthub.reportstudio.dto.PageResponse;
import io.reporthub.reportstudio.dto.ReportCodeNameDto;
import io.reporthub.reportstudio.dto.ReportDetailDto;
import io.reporthub.reportstudio.dto.ReportSummaryDto;
import io.reporthub.reportstudio.dto.UpdateReportRequest;
import io.reporthub.reportstudio.dto.VersionDto;
import io.reporthub.reportstudio.security.EdgeBearerAuthFilter;
import io.reporthub.reportstudio.service.ReportService;

@RestController
@RequestMapping("/reports")
public class ReportController {

    private final ReportService reportService;

    public ReportController(ReportService reportService) {
        this.reportService = reportService;
    }

    @GetMapping
    public PageResponse<ReportSummaryDto> list(
            @RequestParam(required = false) String category,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String engine,
            @RequestParam(required = false) String datasource,
            @RequestParam(required = false) String q,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(defaultValue = "updatedAt,desc") String sort,
            Authentication auth) {
        // Only a caller who arrived through the portal carries identity-provider roles, so only
        // they get the per-report visibility filter; a direct login gets null = no filter.
        if (status != null && !status.isBlank()) status = io.reporthub.reportstudio.service.ReportService.checkStatusFilter(status);
        if (engine != null && !engine.isBlank() && !engine.trim().matches("[A-Za-z0-9_.-]{1,32}")) {
            throw new BadRequestException("Invalid engine '" + engine + "'");
        }
        if (page < 0) throw new BadRequestException("page must be >= 0");
        if (size < 1) throw new BadRequestException("size must be >= 1");
        return reportService.search(category, status, engine, datasource, q,
                EdgeBearerAuthFilter.portalRolesOf(auth),
                PageRequest.of(page, Math.min(size, 400), parseSort(sort)));
    }

    /**
     * Flat {@code [{"code":"…","name":"…"}]} feed of the registry for other apps' report pickers.
     * Declared before {@code /{code}} for readability — the literal segment already wins over the
     * template in Spring's pattern ordering, so a report code is never swallowed by it.
     *
     * <p>{@code produces} is pinned because jackson-dataformat-xml is on the classpath: without it
     * a caller sending {@code Accept: application/xml} would get XML back from a JSON contract.
     */
    @GetMapping(value = "/codes", produces = MediaType.APPLICATION_JSON_VALUE)
    public java.util.List<ReportCodeNameDto> codes(Authentication auth) {
        return reportService.codeList(EdgeBearerAuthFilter.portalRolesOf(auth));
    }

    @GetMapping("/{code}")
    public ReportDetailDto get(@PathVariable String code) {
        return reportService.getByCode(code);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ReportDetailDto create(@Valid @RequestBody CreateReportRequest req) {
        return reportService.create(req);
    }

    /** Config-screen save (replaces the old read-only YAML view). */
    @PutMapping("/{code}")
    public ReportDetailDto update(@PathVariable String code,
                                  @RequestBody UpdateReportRequest req,
                                  Authentication auth) {
        return reportService.update(code, req, auth == null ? "system" : auth.getName());
    }

    /** Delete a report and all its units/files/params/versions (DB cascades; MinIO templates cleaned up). */
    @DeleteMapping("/{code}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String code) {
        reportService.delete(code);
    }

    /** Real version history (report_version rows). */
    @GetMapping("/{code}/versions")
    public java.util.List<VersionDto> versions(@PathVariable String code) {
        return reportService.versionsOf(code);
    }

    /** Report fields a caller may sort the registry by. */
    static final java.util.Set<String> SORTABLE = java.util.Set.of(
            "code", "name", "categoryId", "engine", "status", "updatedAt", "version", "runs", "avgMs",
            "ownerUnit", "formats", "datasourceId", "paramCount");

    static Sort parseSort(String sort) {
        String[] parts = (sort == null ? "" : sort).split(",");
        String prop = parts.length == 0 || parts[0].isBlank() ? "updatedAt" : parts[0].trim();
        if (!SORTABLE.contains(prop)) {
            throw new BadRequestException("Unknown sort field '" + prop + "'. Allowed: "
                    + String.join(", ", new java.util.TreeSet<>(SORTABLE)));
        }
        if (parts.length > 2) throw new BadRequestException("sort must be FIELD or FIELD,asc|desc");
        String d = parts.length > 1 ? parts[1].trim() : "desc";
        if (!d.equalsIgnoreCase("asc") && !d.equalsIgnoreCase("desc")) {
            throw new BadRequestException("Unknown sort direction '" + d + "'. Allowed: asc, desc");
        }
        Sort.Direction dir = d.equalsIgnoreCase("asc") ? Sort.Direction.ASC : Sort.Direction.DESC;
        return Sort.by(dir, prop);
    }
}
