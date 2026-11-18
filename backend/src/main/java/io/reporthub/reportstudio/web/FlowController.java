package io.reporthub.reportstudio.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.domain.Report;
import io.reporthub.reportstudio.domain.ReportFlow;
import io.reporthub.reportstudio.repo.ReportFlowRepository;
import io.reporthub.reportstudio.repo.ReportRepository;

import java.time.OffsetDateTime;
import java.util.Map;

/**
 * Per-report render-pipeline flow (React Flow document). GET returns the saved flow or a
 * default generated from the report's actual gateway pipeline (ingress → queue → worker →
 * engine → store); PUT persists the edited document.
 */
@RestController
public class FlowController {

    private final ReportFlowRepository flows;
    private final ReportRepository reports;
    private final ObjectMapper json;

    public FlowController(ReportFlowRepository flows, ReportRepository reports, ObjectMapper json) {
        this.flows = flows;
        this.reports = reports;
        this.json = json;
    }

    @GetMapping("/reports/{code}/flow")
    public JsonNode get(@PathVariable String code) throws Exception {
        Report r = reports.findByCode(code)
                .orElseThrow(() -> new NotFoundException("Report not found: " + code));
        var saved = flows.findById(code);
        if (saved.isPresent()) {
            var doc = (com.fasterxml.jackson.databind.node.ObjectNode) json.readTree(saved.get().getFlowJson());
            doc.put("saved", true);
            doc.put("updatedAt", String.valueOf(saved.get().getUpdatedAt()));
            doc.put("updatedBy", saved.get().getUpdatedBy() == null ? "" : saved.get().getUpdatedBy());
            java.util.List<String> notRun = markExecution(doc);
            doc.put("executed", notRun.isEmpty());
            var arr = doc.putArray("notExecutedStages");
            notRun.forEach(arr::add);
            return doc;
        }
        return defaultFlow(r);
    }

    @PutMapping("/reports/{code}/flow")
    public Map<String, Object> put(@PathVariable String code,
                                   @RequestBody JsonNode body,
                                   Authentication auth) throws Exception {
        reports.findByCode(code)
                .orElseThrow(() -> new NotFoundException("Report not found: " + code));
        if (body == null || !body.has("nodes") || !body.get("nodes").isArray()) {
            throw new BadRequestException("Flow document must contain a nodes[] array");
        }
        ReportFlow f = flows.findById(code).orElseGet(() -> {
            ReportFlow nf = new ReportFlow();
            nf.setReportCode(code);
            return nf;
        });
        java.util.List<String> notRun = markExecution(body);
        f.setFlowJson(json.writeValueAsString(body));
        f.setUpdatedBy(auth == null ? "system" : auth.getName());
        f.setUpdatedAt(OffsetDateTime.now());
        flows.save(f);
        Map<String, Object> res = new java.util.LinkedHashMap<>();
        res.put("ok", true);
        res.put("reportCode", code);
        res.put("nodes", body.get("nodes").size());
        // The flow is a diagram of the fixed render pipeline. Extra stages (validate, notify, ...)
        // are stored for documentation only - the worker does not execute them.
        res.put("executed", notRun.isEmpty());
        res.put("notExecutedStages", notRun);
        return res;
    }

    /** Stage kinds that correspond to real steps of the render pipeline. */
    static final java.util.Set<String> PIPELINE_KINDS = java.util.Set.of("ingress", "queue", "worker", "engine", "store");

    /**
     * Sets {@code data.executed} on every node (true only for real pipeline stages) and returns the
     * ids/labels of stages that are saved but not run.
     */
    static java.util.List<String> markExecution(JsonNode doc) {
        java.util.List<String> notRun = new java.util.ArrayList<>();
        for (JsonNode n : doc.path("nodes")) {
            if (!(n instanceof com.fasterxml.jackson.databind.node.ObjectNode on)) continue;
            JsonNode d = on.path("data");
            com.fasterxml.jackson.databind.node.ObjectNode data = d instanceof com.fasterxml.jackson.databind.node.ObjectNode od
                    ? od : on.putObject("data");
            String kind = data.path("kind").asText("");
            boolean exec = PIPELINE_KINDS.contains(kind);
            data.put("executed", exec);
            if (!exec) {
                String label = data.path("label").asText("");
                notRun.add(label.isBlank() ? on.path("id").asText(kind) : label);
            }
        }
        return notRun;
    }

    /** Default document mirroring the real gateway pipeline for this report. */
    private JsonNode defaultFlow(Report r) {
        var doc = json.createObjectNode();
        doc.put("saved", false);
        var nodes = doc.putArray("nodes");
        var edges = doc.putArray("edges");

        String engine = r.getEngine() == null ? "jasper" : r.getEngine();
        record N(String id, String kind, String label, String sub, int x) {}
        N[] defs = {
                new N("ingress", "ingress", "API Gateway", "REST ingress · POST /reports/" + r.getCode() + "/run", 0),
                new N("queue",   "queue",   "Job Queue", "postgres: job table", 260),
                new N("worker",  "worker",  "Worker Pool", "render workers claim jobs from the queue", 520),
                new N("engine",  "engine",  engineLabel(engine), "engine: " + engine, 780),
                new N("store",   "store",   "Output Store", "S3 / MinIO · bucket report-outputs", 1040),
        };
        String prev = null;
        for (N n : defs) {
            var node = nodes.addObject();
            node.put("id", n.id());
            node.put("type", "stage");
            var pos = node.putObject("position");
            pos.put("x", n.x());
            pos.put("y", 120);
            var data = node.putObject("data");
            data.put("kind", n.kind());
            data.put("label", n.label());
            data.put("sub", n.sub());
            if (prev != null) {
                var e = edges.addObject();
                e.put("id", "e-" + prev + "-" + n.id());
                e.put("source", prev);
                e.put("target", n.id());
                e.put("animated", true);
            }
            prev = n.id();
        }
        return doc;
    }

    private static String engineLabel(String engine) {
        return switch (engine) {
            case "jasper" -> "Jasper Engine";
            case "component" -> "Component Engine";
            case "api" -> "API Engine";
            case "sql" -> "SQL Engine";
            case "composite" -> "Composite Engine";
            default -> engine + " Engine";
        };
    }
}
