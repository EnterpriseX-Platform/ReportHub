package io.reporthub.reportstudio.service;

import org.springframework.stereotype.Service;
import io.reporthub.reportstudio.domain.ReportUnit;
import io.reporthub.reportstudio.domain.ReportUnitFile;
import io.reporthub.reportstudio.repo.ReportUnitFileRepository;
import io.reporthub.reportstudio.repo.ReportUnitRepository;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/** Read-side helpers for shared resources — chiefly: which reports reference a given resource. */
@Service
public class ResourceService {

    private final ReportUnitFileRepository unitFiles;
    private final ReportUnitRepository units;

    public ResourceService(ReportUnitFileRepository unitFiles, ReportUnitRepository units) {
        this.unitFiles = unitFiles;
        this.units = units;
    }

    /**
     * Reports that reference a shared resource by file name. Two ways a report can use it:
     * (1) a per-unit file with role=resource and the same name, (2) a configJson that mentions the
     * name (composite / api / custom engines). Returns human-readable "REPORT-CODE / unit" labels.
     */
    public List<String> findUsages(String resourceName) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        for (ReportUnitFile f : unitFiles.findByRoleAndFileName("resource", resourceName)) {
            units.findById(f.getUnitId())
                    .ifPresent(u -> out.add(u.getReportCode() + " / " + u.getName()));
        }
        // Match the name as a whole token, so "logo.png" doesn't match "company_logo.png".
        // (Not preceded/followed by a word char or hyphen — quote/slash/space boundaries count.)
        java.util.regex.Pattern token = java.util.regex.Pattern.compile(
                "(?<![\\w-])" + java.util.regex.Pattern.quote(resourceName) + "(?![\\w-])");
        for (ReportUnit u : units.findAll()) {
            if (u.getConfigJson() != null && token.matcher(u.getConfigJson()).find()) {
                out.add(u.getReportCode() + " / " + u.getName() + " (config)");
            }
        }
        return new ArrayList<>(out);
    }
}
