package io.reporthub.reportstudio.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import io.reporthub.reportstudio.analytics.AdhocRequest;
import io.reporthub.reportstudio.analytics.AdhocResult;
import io.reporthub.reportstudio.analytics.AdhocService;
import io.reporthub.reportstudio.analytics.PivotRequest;
import io.reporthub.reportstudio.analytics.PivotResponse;
import io.reporthub.reportstudio.analytics.PivotService;
import io.reporthub.reportstudio.analytics.XlsxExporter;
import io.reporthub.reportstudio.domain.SavedView;
import io.reporthub.reportstudio.web.BadRequestException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Turns a saved view into a DATA PRODUCT: executes its payload (pivot, warehouse ad-hoc,
 * or ad-hoc over a custom dataset) and renders the result as JSON rows, CSV, or XLSX —
 * consumed by the authed export endpoints and the public share-token URL.
 */
@Service
public class ViewExportService {

    public record Table(List<String> columns, List<List<Object>> rows) {}

    private final PivotService pivotService;
    private final AdhocService adhocService;
    private final DatasetService datasetService;
    private final io.reporthub.reportstudio.repo.DatasetDefRepository datasetRepo;
    private final RepositoryService repositoryService;
    private final XlsxExporter xlsx;
    private final ObjectMapper json;

    public ViewExportService(PivotService pivotService, AdhocService adhocService,
                             DatasetService datasetService,
                             io.reporthub.reportstudio.repo.DatasetDefRepository datasetRepo,
                             RepositoryService repositoryService,
                             XlsxExporter xlsx, ObjectMapper json) {
        this.pivotService = pivotService;
        this.adhocService = adhocService;
        this.datasetService = datasetService;
        this.datasetRepo = datasetRepo;
        this.repositoryService = repositoryService;
        this.xlsx = xlsx;
        this.json = json;
    }

    /** Execute the view's stored payload and normalize to a flat table. */
    public Table run(SavedView v) {
        try {
            JsonNode p = json.readTree(v.getPayload());
            if ("pivot".equals(v.getKind())) {
                PivotRequest req = json.treeToValue(p, PivotRequest.class);
                PivotResponse res = pivotService.pivot(req);
                List<String> cols = new ArrayList<>();
                cols.add("dimension");
                boolean hasCols = !res.colKeys().isEmpty() && !"__total".equals(res.colKeys().get(0));
                if (hasCols) cols.addAll(res.colKeys());
                cols.add("total");
                List<List<Object>> rows = new ArrayList<>();
                res.rows().forEach(r -> {
                    List<Object> row = new ArrayList<>();
                    row.add(r.label());
                    if (hasCols) res.colKeys().forEach(ck -> row.add(r.vals().getOrDefault(ck, 0L)));
                    row.add(r.rowTotal());
                    rows.add(row);
                });
                return new Table(cols, rows);
            }
            // sql: a saved SQL script from the Ad-hoc / Tables editor — payload {datasourceId, sql}.
            // Without this branch a "sql" view fell through to the ad-hoc path below, which ignores
            // the SQL entirely and exports the fact table instead: an export that succeeds with the
            // wrong data, which is worse than one that fails.
            if ("sql".equals(v.getKind())) {
                String sql = p.path("sql").asText("");
                if (sql.isBlank()) throw new BadRequestException("This saved SQL has no statement to run");
                String dsId = p.path("datasourceId").isNull() ? null : p.path("datasourceId").asText(null);
                return runSql(dsId, sql);
            }

            // adhoc: builder payload {dataset, picked, filters} or raw AdhocRequest {fields, filters}
            String dataset = p.path("dataset").asText("");
            if (dataset.startsWith("custom-")) {
                long id = Long.parseLong(dataset.substring("custom-".length()));
                var def = datasetRepo.findById(id)
                        .orElseThrow(() -> new BadRequestException("Dataset missing: " + dataset));
                List<String> picked = toList(p.path("picked"));
                var fields = datasetService.fields(def);
                List<String> unknown = picked.stream().filter(f -> fields.stream()
                        .noneMatch(c -> c.name().equalsIgnoreCase(f))).toList();
                if (!unknown.isEmpty()) {
                    throw new BadRequestException("Unknown column(s) " + unknown + " — dataset has "
                            + fields.stream().map(c -> c.name()).toList());
                }
                List<String> dims = picked.stream().filter(f -> fields.stream()
                        .anyMatch(c -> c.name().equalsIgnoreCase(f) && c.kind().equals("dim"))).toList();
                List<String> measures = picked.stream().filter(f -> fields.stream()
                        .anyMatch(c -> c.name().equalsIgnoreCase(f) && c.kind().equals("measure"))).toList();
                DatasetService.TableResult r = datasetService.aggregate(def, dims, measures, toMap(p.path("filters")));
                return new Table(r.columns(), r.rows());
            }
            List<String> fields = p.has("picked") ? mapBuilderFields(toList(p.path("picked"))) : toList(p.path("fields"));
            AdhocResult res = adhocService.run(new AdhocRequest("fact", fields, toMap(p.path("filters"))));
            List<List<Object>> rows = new ArrayList<>();
            res.rows().forEach(r -> {
                List<Object> row = new ArrayList<>();
                res.columns().forEach(c -> row.add(r.get(c)));
                rows.add(row);
            });
            return new Table(res.columns(), rows);
        } catch (BadRequestException be) {
            throw be;
        } catch (Exception e) {
            throw new BadRequestException("View execution failed: " + e.getMessage());
        }
    }

    /**
     * Run one SELECT through the SQL-editor path and flatten it — shared by the saved "sql" views
     * and by the Ad-hoc SQL editor's own export. Only a SELECT can be exported: everything else
     * changes data, and a download button must never be a way to run an UPDATE.
     */
    public Table runSql(String datasourceId, String sql) {
        RepositoryService.ExecResult res = repositoryService.execute(datasourceId, sql);
        return toTable(res);
    }

    public Table runSql(String datasourceId, String sql, Map<String, String> params) {
        return toTable(repositoryService.execute(datasourceId, sql, params == null ? Map.of() : params));
    }

    private static Table toTable(RepositoryService.ExecResult res) {
        if (!"select".equals(res.kind())) {
            throw new BadRequestException("Only a SELECT can be exported — this statement changes data");
        }
        List<List<Object>> rows = new ArrayList<>();
        res.rows().forEach(r -> rows.add(new ArrayList<>(r)));
        return new Table(res.columns(), rows);
    }

    public byte[] toCsv(Table t) {
        StringBuilder sb = new StringBuilder("﻿");           // BOM so Excel reads UTF-8 non-ASCII text
        sb.append(String.join(",", t.columns().stream().map(ViewExportService::csv).toList())).append("\r\n");
        for (List<Object> r : t.rows()) {
            sb.append(String.join(",", r.stream().map(v -> csv(v == null ? "" : String.valueOf(v))).toList())).append("\r\n");
        }
        return sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    public byte[] toXlsx(Table t) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (List<Object> r : t.rows()) {
            Map<String, Object> m = new LinkedHashMap<>();
            for (int i = 0; i < t.columns().size(); i++) m.put(t.columns().get(i), r.get(i));
            rows.add(m);
        }
        Map<String, Long> totals = new LinkedHashMap<>();
        for (int i = 0; i < t.columns().size(); i++) {
            final int idx = i;
            boolean numeric = t.rows().stream().anyMatch(r -> r.get(idx) instanceof Number);
            if (numeric) totals.put(t.columns().get(i),
                    Math.round(t.rows().stream().mapToDouble(r -> r.get(idx) instanceof Number n ? n.doubleValue() : 0).sum()));
        }
        AdhocResult shaped = new AdhocResult(t.columns(),
                rows.stream().map(m -> {
                    Map<String, Object> mm = new LinkedHashMap<>(m);
                    mm.replaceAll((k, val) -> val == null ? "" : val);
                    return (Map<String, Object>) mm;
                }).toList(),
                totals, t.rows().size());
        return xlsx.adhoc(shaped);
    }

    private static String csv(String s) {
        return (s.contains(",") || s.contains("\"") || s.contains("\n"))
                ? "\"" + s.replace("\"", "\"\"") + "\"" : s;
    }

    private List<String> toList(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.forEach(x -> out.add(x.asText()));
        return out;
    }

    private Map<String, String> toMap(JsonNode n) {
        Map<String, String> out = new LinkedHashMap<>();
        n.fields().forEachRemaining(e -> out.put(e.getKey(), e.getValue().asText()));
        return out;
    }

    /** Ad-hoc builder local field ids → backend keys (year → fiscalYear). */
    private static List<String> mapBuilderFields(List<String> picked) {
        return picked.stream().map(f -> "year".equals(f) ? "fiscalYear" : f).toList();
    }
}
