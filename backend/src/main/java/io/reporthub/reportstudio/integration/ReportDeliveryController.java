package io.reporthub.reportstudio.integration;

import io.reporthub.reportstudio.domain.Report;
import io.reporthub.reportstudio.repo.ReportRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;

/** Per-report "Deliver to FileHub" setting, applied by the render worker after each stored output. */
@RestController
public class ReportDeliveryController {

    public record DeliveryBody(String connectorId, String path) {}

    private final ReportRepository reports;
    private final ConnectorStore connectors;

    public ReportDeliveryController(ReportRepository reports, ConnectorStore connectors) {
        this.reports = reports;
        this.connectors = connectors;
    }

    @GetMapping("/reports/{code}/delivery")
    public Map<String, Object> get(@PathVariable String code) {
        return dto(require(code));
    }

    @PutMapping("/reports/{code}/delivery")
    public Map<String, Object> put(@PathVariable String code, @RequestBody DeliveryBody b) {
        Report r = require(code);
        String id = b == null || b.connectorId() == null ? "" : b.connectorId().trim();
        String path = b == null || b.path() == null ? "" : b.path().trim();
        if (!id.isEmpty()) {
            ConnectorStore.Row c = connectors.find(id).orElseThrow(() -> new BadRequestException("Unknown connector: " + id));
            if (!ConnectorTypes.FILEHUB.equals(c.type())) throw new BadRequestException("Delivery needs a FileHub connector");
        }
        if (path.length() > 400) throw new BadRequestException("Folder path is too long (max 400)");
        r.setDeliveryConnectorId(id.isEmpty() ? null : id);
        r.setDeliveryPath(path.isEmpty() ? null : path);
        reports.save(r);
        return dto(r);
    }

    private Report require(String code) {
        return reports.findByCode(code).orElseThrow(() -> new NotFoundException("Report not found: " + code));
    }

    private static Map<String, Object> dto(Report r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("connectorId", r.getDeliveryConnectorId());
        m.put("path", r.getDeliveryPath());
        m.put("example", DeliveryPath.render(r.getDeliveryPath(), r.getCode(), LocalDate.now()));
        return m;
    }
}
