package io.reporthub.reportstudio.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.analytics.AdhocRequest;
import io.reporthub.reportstudio.analytics.AdhocResult;
import io.reporthub.reportstudio.analytics.AdhocService;
import io.reporthub.reportstudio.analytics.PivotRequest;
import io.reporthub.reportstudio.analytics.PivotResponse;
import io.reporthub.reportstudio.analytics.PivotService;
import io.reporthub.reportstudio.domain.Dashboard;
import io.reporthub.reportstudio.domain.DatasetDef;
import io.reporthub.reportstudio.repo.DashboardRepository;
import io.reporthub.reportstudio.service.DatasetService;

import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * BI dashboards: a grid of widgets over the warehouse (pivot/ad-hoc) or user datasets,
 * each rendered as table / bar / line / heatmap. A dashboard can be shared by a public
 * token URL — {@code GET /public/dash/{token}} (permitAll) executes every widget
 * server-side and returns the data, so viewers need no account.
 */
@RestController
public class DashboardBuilderController {

    public record DashboardDto(Long id, String name, String layoutJson, String paramsJson,
                               String shareToken, Long workspaceId, String folder,
                               String createdBy, OffsetDateTime updatedAt) {}
    public record SaveDashboardRequest(@NotBlank String name, @NotBlank String layoutJson, String paramsJson,
                                       Long workspaceId, String folder) {}

    private final DashboardRepository repo;
    private final PivotService pivotService;
    private final AdhocService adhocService;
    private final DatasetService datasetService;
    private final io.reporthub.reportstudio.repo.DatasetDefRepository datasetRepo;
    private final ObjectMapper json;

    public DashboardBuilderController(DashboardRepository repo,
                                      PivotService pivotService,
                                      AdhocService adhocService,
                                      DatasetService datasetService,
                                      io.reporthub.reportstudio.repo.DatasetDefRepository datasetRepo,
                                      ObjectMapper json) {
        this.repo = repo;
        this.pivotService = pivotService;
        this.adhocService = adhocService;
        this.datasetService = datasetService;
        this.datasetRepo = datasetRepo;
        this.json = json;
    }

    // ---- CRUD ----

    @GetMapping("/dashboards")
    public List<DashboardDto> list() {
        return repo.findAllByOrderByUpdatedAtDesc().stream().map(DashboardBuilderController::toDto).toList();
    }

    @PostMapping("/dashboards")
    @ResponseStatus(HttpStatus.CREATED)
    public DashboardDto create(@Valid @RequestBody SaveDashboardRequest req, Authentication auth) {
        Dashboard d = new Dashboard();
        d.setName(req.name().trim());
        d.setLayoutJson(req.layoutJson());
        d.setParamsJson(req.paramsJson());
        d.setWorkspaceId(req.workspaceId() == null ? 1L : req.workspaceId());
        d.setFolder(req.folder() == null || req.folder().isBlank() ? null : req.folder().trim());
        d.setCreatedBy(auth == null ? "system" : auth.getName());
        d.setCreatedAt(OffsetDateTime.now());
        d.setUpdatedAt(OffsetDateTime.now());
        return toDto(repo.save(d));
    }

    @PutMapping("/dashboards/{id}")
    public DashboardDto update(@PathVariable Long id, @Valid @RequestBody SaveDashboardRequest req) {
        Dashboard d = require(id);
        d.setName(req.name().trim());
        d.setLayoutJson(req.layoutJson());
        d.setParamsJson(req.paramsJson());
        if (req.workspaceId() != null) d.setWorkspaceId(req.workspaceId());
        d.setFolder(req.folder() == null || req.folder().isBlank() ? null : req.folder().trim());
        d.setUpdatedAt(OffsetDateTime.now());
        return toDto(repo.save(d));
    }

    @DeleteMapping("/dashboards/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        repo.delete(require(id));
    }

    // ---- share ----

    @PostMapping("/dashboards/{id}/share")
    public DashboardDto share(@PathVariable Long id) {
        Dashboard d = require(id);
        if (d.getShareToken() == null) {
            d.setShareToken(UUID.randomUUID().toString().replace("-", ""));
            repo.save(d);
        }
        return toDto(d);
    }

    @DeleteMapping("/dashboards/{id}/share")
    public DashboardDto unshare(@PathVariable Long id) {
        Dashboard d = require(id);
        d.setShareToken(null);
        repo.save(d);
        return toDto(d);
    }

    // ---- data execution (authed by id, public by token) ----

    /** Extra query params act as RUNTIME FILTERS (merged over the saved params) — powers
     *  the dashboard filter bar and click-to-filter interactions. */
    @GetMapping("/dashboards/{id}/data")
    public ObjectNode data(@PathVariable Long id,
                           @org.springframework.web.bind.annotation.RequestParam Map<String, String> q) throws Exception {
        return execute(require(id), q);
    }

    /** PUBLIC view — resolves the share token; no authentication required. */
    @GetMapping("/public/dash/{token}")
    public ObjectNode publicData(@PathVariable String token) throws Exception {
        Dashboard d = repo.findByShareToken(token)
                .orElseThrow(() -> new NotFoundException("Dashboard not found"));
        return execute(d, Map.of());
    }

    /** Run every widget server-side and bundle name + params + widget data. */
    private ObjectNode execute(Dashboard d, Map<String, String> runtimeFilters) throws Exception {
        ObjectNode out = json.createObjectNode();
        out.put("id", d.getId());
        out.put("name", d.getName());
        out.put("paramsJson", d.getParamsJson() == null ? "{}" : d.getParamsJson());
        out.put("updatedAt", String.valueOf(d.getUpdatedAt()));

        Map<String, String> params = new HashMap<>();
        if (d.getParamsJson() != null && !d.getParamsJson().isBlank()) {
            JsonNode p = json.readTree(d.getParamsJson());
            p.fields().forEachRemaining(e -> params.put(e.getKey(), e.getValue().asText()));
        }
        runtimeFilters.forEach((k, v) -> { if (v != null && !v.isBlank()) params.put(k, v); });

        ArrayNode widgetsOut = out.putArray("widgets");
        JsonNode layout = json.readTree(d.getLayoutJson());
        for (JsonNode w : layout.path("widgets")) {
            ObjectNode wo = widgetsOut.addObject();
            wo.put("title", w.path("title").asText("Widget"));
            wo.put("viz", w.path("viz").asText("table"));
            wo.put("w", w.path("w").asInt(1));
            wo.put("kind", w.path("kind").asText(""));
            // hint for click-to-filter: the field a bar click should filter on
            if ("pivot".equals(w.path("kind").asText("")) && w.path("payload").path("rows").path(0).isTextual()) {
                wo.put("filterField", w.path("payload").path("rows").path(0).asText());
            }
            try {
                wo.set("data", runWidget(w, params));
            } catch (Exception e) {
                wo.put("error", e.getMessage() == null ? "execution failed" : e.getMessage());
            }
        }
        return out;
    }

    private JsonNode runWidget(JsonNode w, Map<String, String> globalParams) throws Exception {
        String kind = w.path("kind").asText();
        JsonNode payload = w.path("payload");
        switch (kind) {
            case "pivot" -> {
                PivotRequest req = json.treeToValue(payload, PivotRequest.class);
                Map<String, String> filters = new HashMap<>(req.filters() == null ? Map.of() : req.filters());
                globalParams.forEach((k, v) -> { if (!v.isBlank()) filters.put(k, v); });
                PivotResponse res = pivotService.pivot(new PivotRequest(req.rows(), req.cols(), req.measure(), filters));
                return json.valueToTree(res);
            }
            case "adhoc" -> {
                AdhocRequest req = json.treeToValue(payload, AdhocRequest.class);
                // global params override matching filters (e.g. fiscalYear)
                Map<String, String> filters = new HashMap<>(req.filters() == null ? Map.of() : req.filters());
                globalParams.forEach((k, v) -> { if (!v.isBlank()) filters.put(k, v); });
                AdhocResult res = adhocService.run(new AdhocRequest(req.dataset(), req.fields(), filters));
                return json.valueToTree(res);
            }
            case "dataset" -> {
                long datasetId = w.path("datasetId").asLong();
                DatasetDef def = datasetRepo.findById(datasetId)
                        .orElseThrow(() -> new NotFoundException("Dataset not found: " + datasetId));
                @SuppressWarnings("unused")
                List<String> dims = json.convertValue(payload.path("dims"),
                        json.getTypeFactory().constructCollectionType(List.class, String.class));
                List<String> measures = json.convertValue(payload.path("measures"),
                        json.getTypeFactory().constructCollectionType(List.class, String.class));
                Map<String, String> filters = json.convertValue(payload.path("filters"),
                        json.getTypeFactory().constructMapType(Map.class, String.class, String.class));
                if (filters == null) filters = new HashMap<>();
                // runtime/global filters apply when the key is a real column of the dataset
                var colNames = datasetService.fields(def).stream().map(c -> c.name()).toList();
                for (var e : globalParams.entrySet()) {
                    String match = colNames.stream().filter(c -> c.equalsIgnoreCase(e.getKey())).findFirst().orElse(null);
                    if (match != null && !e.getValue().isBlank()) filters.put(match, e.getValue());
                }
                DatasetService.TableResult res = datasetService.aggregate(def,
                        dims == null ? List.of() : dims,
                        measures == null ? List.of() : measures,
                        filters);
                return json.valueToTree(res);
            }
            default -> throw new BadRequestException("Unknown widget kind: " + kind);
        }
    }

    private Dashboard require(Long id) {
        return repo.findById(id).orElseThrow(() -> new NotFoundException("Dashboard not found: " + id));
    }

    private static DashboardDto toDto(Dashboard d) {
        return new DashboardDto(d.getId(), d.getName(), d.getLayoutJson(), d.getParamsJson(),
                d.getShareToken(), d.getWorkspaceId(), d.getFolder(), d.getCreatedBy(), d.getUpdatedAt());
    }
}
