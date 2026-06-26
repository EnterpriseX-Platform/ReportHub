package io.reporthub.reportstudio.engine.remote;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.engine.EngineConfig;
import io.reporthub.reportstudio.engine.EngineProp;
import io.reporthub.reportstudio.engine.ReportEngine;
import io.reporthub.reportstudio.engine.builtin.JasperReportEngine;
import io.reporthub.reportstudio.render.RenderException;
import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;
import io.reporthub.reportstudio.render.ReportRenderer;
import io.reporthub.reportstudio.render.TabularData;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * REST API engine: fetches JSON from a per-report endpoint, flattens it to a table, and renders it
 * to CSV/XLSX/PDF via the shared {@link ReportRenderer} writers. Built-in (in-process HTTP client),
 * so it needs no installed instance — the endpoint is configured per report in the unit's configJson:
 * {@code {"endpoint":"https://api/...","method":"GET","dataPath":"data.items"}}. {@code $P{param}}
 * placeholders in the endpoint are substituted (URL-encoded) from the run parameters.
 */
@Component
public class ApiReportEngine implements ReportEngine {

    public static final String KIND = "api";
    private static final Logger log = LoggerFactory.getLogger(ApiReportEngine.class);
    private static final Pattern P_PLACEHOLDER = Pattern.compile("\\$P!?\\{([^}]+)\\}");

    private final ObjectMapper mapper;
    private final ReportRenderer renderer;
    private final JasperReportEngine jasper;
    private final HttpClient http;

    public ApiReportEngine(ObjectMapper kafkaObjectMapper, ReportRenderer renderer, JasperReportEngine jasper,
                           @org.springframework.beans.factory.annotation.Value("${app.engine.remote.insecure-tls:false}") boolean insecureTls) {
        this.mapper = kafkaObjectMapper;
        this.renderer = renderer;
        this.jasper = jasper;
        this.http = InsecureTls.client(insecureTls, Duration.ofSeconds(15));
    }

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public String label() {
        return "REST API";
    }

    @Override
    public List<EngineProp> reportProps() {
        return List.of(
                new EngineProp("endpoint", "Endpoint URL", "url", true,
                        "https://api.example/v1/report?fy=$P{fiscalYear}",
                        "$P{paramName} is substituted (URL-encoded) from the run parameters",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("method", "HTTP method", "select", false, "GET", null,
                        List.of("GET", "POST"), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("dataPath", "Data path", "text", false, "data.items",
                        "dot-path to the array of rows in the JSON response (blank = response root)",
                        List.of(), EngineProp.UNIT_CONFIG_JSON));
    }

    @Override
    public RenderResult render(RenderRequest req, EngineConfig cfg) {
        JsonNode config;
        try {
            config = (req.configJson() == null || req.configJson().isBlank())
                    ? mapper.createObjectNode() : mapper.readTree(req.configJson());
        } catch (Exception e) {
            throw new RenderException("api engine: invalid config JSON: " + e.getMessage(), e);
        }
        String endpoint = text(config, "endpoint");
        if (endpoint == null || endpoint.isBlank()) {
            // Backward-compat: engine=api reports created before this engine existed have a .jrxml
            // template and no endpoint, and rendered via the resolver's old Jasper fallback. Preserve
            // that EXACTLY — render the template through Jasper — until an endpoint is configured.
            // Without this, every pre-existing api report (e.g. the 388/540-run UAT reports) would
            // start failing the moment this engine claims kind=api.
            return jasper.render(req, cfg);
        }
        String method = text(config, "method");
        if (method == null || method.isBlank()) method = "GET";
        String dataPath = text(config, "dataPath");
        Map<String, Object> params = req.params() == null ? Map.of() : req.params();
        String url = substitute(endpoint, params);
        guardEndpoint(endpoint, url);
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder().uri(URI.create(url))
                    .timeout(Duration.ofSeconds(60)).header("Accept", "application/json");
            HttpRequest hr = "POST".equalsIgnoreCase(method)
                    ? b.header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(params))).build()
                    : b.GET().build();
            HttpResponse<java.io.InputStream> resp = http.send(hr, HttpResponse.BodyHandlers.ofInputStream());
            if (resp.statusCode() / 100 != 2) {
                try (var body = resp.body()) { body.readAllBytes(); } // drain so the connection is released
                throw new RenderException("api engine: " + method + " " + url + " returned HTTP " + resp.statusCode());
            }
            // Some endpoints (e.g. .../download?fileType=pdf) return a ready-made file rather than JSON
            // rows. Pass that straight through as the artifact instead of trying to parse it as a table.
            String ct = resp.headers().firstValue("Content-Type").orElse("").toLowerCase();
            boolean isJson = ct.isBlank() || ct.contains("json");
            if (!isJson) {
                String fmt = (req.format() == null ? "pdf" : req.format()).toLowerCase();
                java.nio.file.Path tmp = java.nio.file.Files.createTempFile("rs-api-", ".bin");
                try (java.io.InputStream is = resp.body()) {
                    java.nio.file.Files.copy(is, tmp, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
                long size = java.nio.file.Files.size(tmp);
                log.info("api engine: endpoint returned non-JSON ({}) — passing through {} bytes as {}", ct, size, fmt);
                return RenderResult.ofFile(tmp, ct.split(";")[0].trim(), fmt, size);
            }
            JsonNode root;
            try (java.io.InputStream is = resp.body()) {
                // Parse straight from the response stream so we don't hold a full String copy AND the
                // parsed JSON tree on the heap at the same time.
                root = mapper.readTree(is);
            }
            TabularData data = toTabular(navigate(root, dataPath));
            return renderer.renderTabular(req, data);
        } catch (RenderException re) {
            throw re;
        } catch (Exception e) {
            throw new RenderException("api engine fetch failed: " + e.getMessage(), e);
        }
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    /**
     * SSRF guard. The endpoint host is admin-configured and MUST stay fixed: a report runner supplies
     * the $P{...} values, so if a parameter could land in the authority it could redirect the
     * server-side fetch to an internal/metadata host (e.g. 169.254.169.254). We therefore (a) require
     * an http(s) scheme and (b) reject any $P{...} in the template's authority — parameters are only
     * allowed in the path/query. Internal hosts are still allowed (on-prem APIs), just not runner-chosen.
     */
    private static void guardEndpoint(String template, String finalUrl) {
        java.net.URI uri;
        try {
            uri = java.net.URI.create(finalUrl);
        } catch (Exception e) {
            throw new RenderException("api engine: endpoint is not a valid URL after parameter substitution");
        }
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            throw new RenderException("api engine: endpoint must use http or https");
        }
        int schemeSep = template.indexOf("://");
        if (schemeSep >= 0) {
            String afterScheme = template.substring(schemeSep + 3);
            int authEnd = afterScheme.length();
            for (char delim : new char[] {'/', '?', '#'}) {
                int i = afterScheme.indexOf(delim);
                if (i >= 0 && i < authEnd) authEnd = i;
            }
            if (afterScheme.substring(0, authEnd).contains("$P")) {
                throw new RenderException("api engine: the endpoint host must be fixed — "
                        + "$P{...} parameters are only allowed in the path or query string");
            }
        }
    }

    /** Replace $P{name} in the endpoint with URL-encoded run-parameter values. */
    private static String substitute(String tpl, Map<String, Object> params) {
        Matcher m = P_PLACEHOLDER.matcher(tpl);
        StringBuilder out = new StringBuilder(tpl.length() + 16);
        int last = 0;
        while (m.find()) {
            out.append(tpl, last, m.start());
            Object v = params.get(m.group(1));
            out.append(v == null ? "" : URLEncoder.encode(v.toString(), StandardCharsets.UTF_8));
            last = m.end();
        }
        out.append(tpl, last, tpl.length());
        return out.toString();
    }

    /** Walk a dot-path (e.g. "data.items") into the response; blank/unknown returns the root. */
    private static JsonNode navigate(JsonNode root, String dataPath) {
        if (dataPath == null || dataPath.isBlank()) return root;
        JsonNode n = root;
        for (String seg : dataPath.split("\\.")) {
            if (n == null) break;
            n = n.get(seg.trim());
        }
        return n == null ? root : n;
    }

    /** Flatten a JSON array (or single object) into a TabularData: union of object keys = columns. */
    private TabularData toTabular(JsonNode node) {
        List<JsonNode> rows = new ArrayList<>();
        if (node != null && node.isArray()) node.forEach(rows::add);
        else if (node != null && node.isObject()) rows.add(node);
        else if (node != null && node.isValueNode()) rows.add(node); // scalar response -> one "value" row
        LinkedHashSet<String> cols = new LinkedHashSet<>();
        for (JsonNode r : rows) if (r.isObject()) r.fieldNames().forEachRemaining(cols::add);
        if (cols.isEmpty()) cols.add("value");
        List<String> columns = new ArrayList<>(cols);
        TabularData data = new TabularData(columns);
        for (JsonNode r : rows) {
            List<String> cells = new ArrayList<>(columns.size());
            for (String c : columns) {
                JsonNode v = r.isObject() ? r.get(c) : ("value".equals(c) ? r : null);
                cells.add(v == null || v.isNull() ? "" : (v.isValueNode() ? v.asText() : v.toString()));
            }
            data.addRow(cells);
        }
        return data;
    }
}
