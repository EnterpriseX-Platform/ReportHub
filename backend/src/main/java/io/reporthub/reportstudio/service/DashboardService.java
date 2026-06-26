package io.reporthub.reportstudio.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Datasource;
import io.reporthub.reportstudio.domain.ReportCategory;
import io.reporthub.reportstudio.dto.CategoryDto;
import io.reporthub.reportstudio.dto.DashboardSummaryDto;
import io.reporthub.reportstudio.dto.ReportSummaryDto;
import io.reporthub.reportstudio.repo.DatasourceRepository;
import io.reporthub.reportstudio.repo.ReportRepository;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
@Transactional(readOnly = true)
public class DashboardService {

    private final ReportRepository reports;
    private final DatasourceRepository datasources;
    private final CatalogService catalog;
    private final ReportService reportService;
    private final io.reporthub.reportstudio.repo.JobRepository jobs;

    public DashboardService(ReportRepository reports,
                            DatasourceRepository datasources,
                            CatalogService catalog,
                            ReportService reportService,
                            io.reporthub.reportstudio.repo.JobRepository jobs) {
        this.reports = reports;
        this.datasources = datasources;
        this.catalog = catalog;
        this.reportService = reportService;
        this.jobs = jobs;
    }

    public DashboardSummaryDto summary() {
        List<CategoryDto> categories = catalog.categories();
        long registered = reports.count();
        int required = categories.stream().mapToInt(CategoryDto::min).sum();

        Map<String, Long> statusBreakdown = reports.countByStatus().stream()
                .collect(Collectors.toMap(
                        ReportRepository.StatusCount::getStatus,
                        ReportRepository.StatusCount::getCount));
        Map<String, Long> engineBreakdown = reports.countByEngine().stream()
                .collect(Collectors.toMap(
                        ReportRepository.EngineCount::getEngine,
                        ReportRepository.EngineCount::getCount));

        Map<String, ReportCategory> catMap = reportService.categoryMap();
        Map<String, Datasource> dsMap = reportService.datasourceMap();
        List<ReportSummaryDto> recent = reports.findTop8ByOrderByUpdatedAtDesc().stream()
                .map(r -> reportService.toSummary(r, catMap, dsMap))
                .toList();

        // Real operational figures from the job table (today = Asia/Bangkok).
        java.time.ZoneId tz = java.time.ZoneId.of("Asia/Bangkok");
        java.time.OffsetDateTime todayStart =
                java.time.LocalDate.now(tz).atStartOfDay(tz).toOffsetDateTime();
        int runsToday = (int) jobs.countByStartedAtAfter(todayStart);
        int failedToday = (int) jobs.countByStateAndStartedAtAfter("error", todayStart);
        long doneToday = jobs.countByStateAndStartedAtAfter("done", todayStart);
        double successRate = doneToday + failedToday == 0 ? 100.0
                : Math.round(doneToday * 1000.0 / (doneToday + failedToday)) / 10.0;
        int inQueue = (int) (jobs.countByState("queued") + jobs.countByState("running"));
        DashboardSummaryDto.Stats stats = new DashboardSummaryDto.Stats(
                registered, required, (int) datasources.count(),
                runsToday, inQueue, 0, successRate, failedToday);

        return new DashboardSummaryDto(stats, categories, statusBreakdown, engineBreakdown, recent);
    }
}
