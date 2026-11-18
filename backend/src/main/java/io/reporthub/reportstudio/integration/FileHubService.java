package io.reporthub.reportstudio.integration;

import io.reporthub.reportstudio.domain.Job;
import io.reporthub.reportstudio.domain.OutputFile;
import io.reporthub.reportstudio.domain.Report;
import io.reporthub.reportstudio.repo.OutputFileRepository;
import io.reporthub.reportstudio.repo.ReportRepository;
import io.reporthub.reportstudio.storage.ObjectStorageService;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Publishing files to FileHub: on demand (outputs, documents) and automatically after a render. */
@Service
public class FileHubService {

    private static final Logger log = LoggerFactory.getLogger(FileHubService.class);

    public record Published(String connectorId, String fileId, String url, OffsetDateTime publishedAt) {}

    private final ConnectorStore connectors;
    private final ObjectStorageService storage;
    private final OutputFileRepository outputs;
    private final ReportRepository reports;

    public FileHubService(ConnectorStore connectors, ObjectStorageService storage,
                          OutputFileRepository outputs, ReportRepository reports) {
        this.connectors = connectors;
        this.storage = storage;
        this.outputs = outputs;
        this.reports = reports;
    }

    /** The FileHub connector to use: {@code id}, or the only/first enabled one when blank. */
    public ConnectorStore.Row resolve(String id) {
        if (id != null && !id.isBlank()) {
            ConnectorStore.Row r = connectors.find(id.trim())
                    .filter(c -> ConnectorTypes.FILEHUB.equals(c.type()))
                    .orElseThrow(() -> new NotFoundException("FileHub connector not found: " + id));
            if (!r.enabled()) throw new BadRequestException("FileHub connector " + r.name() + " is disabled");
            return r;
        }
        return connectors.byType(ConnectorTypes.FILEHUB).stream().filter(ConnectorStore.Row::enabled).findFirst()
                .orElseThrow(() -> new BadRequestException("No FileHub connector is configured (Integrations → File storage)"));
    }

    public FileHubClient client(ConnectorStore.Row r) {
        return client(r.str("baseUrl"), connectors.secret(r, "apiKey"), r.str("timeoutMs"));
    }

    static FileHubClient client(String baseUrl, String apiKey, String timeoutMs) {
        int ms;
        try { ms = timeoutMs == null || timeoutMs.isBlank() ? 30000 : Integer.parseInt(timeoutMs.trim()); }
        catch (NumberFormatException e) { ms = 30000; }
        return new FileHubClient(baseUrl, apiKey, Duration.ofMillis(Math.max(1000, ms)));
    }

    /** Upload bytes with the connector's target system/org/status and an optional folder path. */
    public Published upload(ConnectorStore.Row c, byte[] bytes, String filename, String contentType,
                            String folderPath, String project) {
        FileHubClient fh = client(c);
        String system = c.str("systemId");
        if (system.isEmpty()) throw new BadRequestException("FileHub connector " + c.name() + " has no target system");
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("system_id", system);
        fields.put("org_id", c.str("orgId"));
        if (folderPath != null && !folderPath.isBlank()) fields.put("folder_id", fh.ensureFolder(system, c.str("orgId"), folderPath));
        fields.put("project", project);
        fields.put("status", c.str("status"));
        fields.put("owner", c.str("owner").isEmpty() ? "ReportHub" : c.str("owner"));
        fields.put("tags", "[\"reporthub\"]");
        FileHubClient.Uploaded up = fh.upload(bytes, filename, contentType, fields);
        return new Published(c.id(), up.id(), FileHubClient.link(fh.baseUrl(), c.str("linkTemplate"), up.id()), OffsetDateTime.now());
    }

    /** Publish one stored output and record the FileHub id/link on it. */
    public Published publishOutput(OutputFile out, String connectorId, String filename, String contentType) {
        ConnectorStore.Row c = resolve(connectorId);
        String folder = DeliveryPath.render(c.str("folderPath"), out.getReportCode(), LocalDate.now());
        Published p = upload(c, storage.get(out.getObjectKey()), filename, contentType, folder, out.getReportCode());
        out.setFilehubConnectorId(p.connectorId());
        out.setFilehubFileId(p.fileId());
        out.setFilehubUrl(p.url());
        out.setFilehubPublishedAt(p.publishedAt());
        outputs.save(out);
        return p;
    }

    /**
     * Render-worker hook: when the report has "Deliver to FileHub" set, upload the new output.
     * Returns a warning message on failure (the render itself is not failed), null otherwise.
     */
    public String deliverAfterRender(Job job, OutputFile out, String filename, String contentType) {
        Report r = reports.findByCode(out.getReportCode()).orElse(null);
        if (r == null || r.getDeliveryConnectorId() == null || r.getDeliveryConnectorId().isBlank()) return null;
        try {
            ConnectorStore.Row c = resolve(r.getDeliveryConnectorId());
            String folder = DeliveryPath.render(
                    r.getDeliveryPath() == null || r.getDeliveryPath().isBlank() ? c.str("folderPath") : r.getDeliveryPath(),
                    out.getReportCode(), LocalDate.now());
            Published p = upload(c, storage.get(out.getObjectKey()), filename, contentType, folder, out.getReportCode());
            out.setFilehubConnectorId(p.connectorId());
            out.setFilehubFileId(p.fileId());
            out.setFilehubUrl(p.url());
            out.setFilehubPublishedAt(p.publishedAt());
            outputs.save(out);
            log.info("Job {} output delivered to FileHub {} as {}", job.getId(), c.id(), p.fileId());
            return null;
        } catch (Exception e) {
            String msg = "FileHub delivery failed: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            log.warn("Job {}: {}", job.getId(), msg);
            return msg;
        }
    }

    /** Connector ids/names usable for publishing (for pickers). */
    public List<Map<String, Object>> targets() {
        return connectors.byType(ConnectorTypes.FILEHUB).stream().filter(ConnectorStore.Row::enabled).map(c -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.id());
            m.put("name", c.name());
            m.put("folderPath", c.str("folderPath"));
            return m;
        }).toList();
    }
}
