package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
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
import io.reporthub.reportstudio.dto.ReportDetailDto;
import io.reporthub.reportstudio.dto.ReportSummaryDto;
import io.reporthub.reportstudio.dto.UpdateReportRequest;
import io.reporthub.reportstudio.dto.VersionDto;
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
            @RequestParam(defaultValue = "updatedAt,desc") String sort) {
        return reportService.search(category, status, engine, datasource, q,
                PageRequest.of(page, Math.min(size, 200), parseSort(sort)));
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

    private static Sort parseSort(String sort) {
        String[] parts = sort.split(",");
        String prop = parts[0].isBlank() ? "updatedAt" : parts[0];
        Sort.Direction dir = (parts.length > 1 && parts[1].equalsIgnoreCase("asc"))
                ? Sort.Direction.ASC : Sort.Direction.DESC;
        return Sort.by(dir, prop);
    }
}
