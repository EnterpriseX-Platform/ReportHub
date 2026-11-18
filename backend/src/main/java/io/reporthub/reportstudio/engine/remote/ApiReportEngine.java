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
import java.util.Arrays;
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
    /** Reads an XML response into a JSON tree so the same navigate()/toTabular() path renders it. Thread-safe. */
    private final com.fasterxml.jackson.dataformat.xml.XmlMapper xmlMapper = new com.fasterxml.jackson.dataformat.xml.XmlMapper();
    private final ReportRenderer renderer;
    private final JasperReportEngine jasper;
    private final HttpClient http;
    /** Per-request response timeout for the endpoint fetch. Configurable because some component document
     *  endpoints (e.g. a large multi-section document) legitimately take 30–120s to render and were
     *  tripping the old fixed 60s cap whenever the shared DB was under load. Env override:
     *  {@code APP_ENGINE_API_REQUEST_TIMEOUT_SECONDS}. */
    private final Duration requestTimeout;
    /** Host suffixes an opt-in (forwardEdgeToken) report may forward the caller's edge token to — an
     *  exfiltration guard so a misconfigured endpoint can never ship a user's SSO token to an arbitrary host. */
    private final List<String> tokenForwardHostSuffixes;
    /** Mints a service-account token for the fallback when a forwardEdgeToken report is run with no edge token. */
    private final EdgeServiceTokenProvider serviceTokens;

    public ApiReportEngine(ObjectMapper objectMapper, ReportRenderer renderer, JasperReportEngine jasper,
                           EdgeServiceTokenProvider serviceTokens,
                           @org.springframework.beans.factory.annotation.Value("${app.engine.remote.insecure-tls:false}") boolean insecureTls,
                           @org.springframework.beans.factory.annotation.Value("${app.engine.api.token-forward-host-suffixes:.svc.cluster.local,localhost}") String tokenForwardHosts,
                           @org.springframework.beans.factory.annotation.Value("${app.engine.api.request-timeout-seconds:180}") long requestTimeoutSeconds) {
        this.mapper = objectMapper;
        this.renderer = renderer;
        this.jasper = jasper;
        this.serviceTokens = serviceTokens;
        this.http = InsecureTls.client(insecureTls, Duration.ofSeconds(15));
        this.tokenForwardHostSuffixes = Arrays.stream(tokenForwardHosts.split(","))
                .map(String::trim).filter(s -> !s.isEmpty()).toList();
        this.requestTimeout = Duration.ofSeconds(requestTimeoutSeconds);
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
                        "https://api.example/v1/report?p=$P{param}",
                        "$P{paramName} is substituted (URL-encoded) from the run parameters; "
                                + "$P{fileType} = the format selected at run time (PDF, WORD for DOCX, EXCEL for XLSX)",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("method", "HTTP method", "select", false, "GET", null,
                        List.of("GET", "POST"), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("requestBody", "Request body (JSON, POST)", "textarea", false,
                        "{\"param\":$P{param},\"config\":{...}}",
                        "Optional JSON body for a POST ($P{param} substituted, JSON-escaped). Blank = run params as JSON.",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("dataPath", "Data path", "text", false, "data.items",
                        "dot-path to the array of rows in the JSON or XML response (blank = response root)",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("headers", "Extra headers (JSON)", "textarea", false,
                        "{\"Authorization\":\"Bearer $P{token}\"}",
                        "Optional JSON object of extra request headers ($P{param} substituted, un-encoded). "
                                + "Use for auth on endpoints that require login, e.g. Authorization or Cookie.",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("forwardEdgeToken", "Forward caller's SSO token", "select", false, "false",
                        "When true, forward the signed-in user's edge (Keycloak) access token as the "
                                + "Authorization / X-Forwarded-Access-Token header, so an endpoint behind the "
                                + "central gateway (e.g. /api/export) runs AS the user. Enable ONLY for trusted "
                                + "internal endpoints — it sends the user's token there. Takes effect only when the "
                                + "report is run via the edge (rs-export button), not the admin Run screen.",
                        List.of("false", "true"), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("fileRefPath", "File-ref path (2-step)", "text", false, "body.sourceFile",
                        "For endpoints that return a JSON envelope with a REFERENCE to a rendered file "
                                + "(e.g. the component: {body:{sourceFile:...}}) instead of the bytes. "
                                + "dot-path to that reference; when set, the engine fetches the real file from "
                                + "downloadUrl and passes it through. Blank = single-step (parse response as rows).",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("downloadUrl", "Download URL (2-step)", "url", false,
                        "http://component-svc:8080/component/file/downloadfile?id={ref}&fileName=report",
                        "Step-2 URL fetched when fileRefPath yields a reference. {ref} = the reference "
                                + "(url-encoded); $P{param} is also substituted. The host must be fixed (SSRF guard).",
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
            // Without this, every pre-existing api report (already in use) would
            // start failing the moment this engine claims kind=api.
            return jasper.render(req, cfg);
        }
        String method = text(config, "method");
        if (method == null || method.isBlank()) method = "GET";
        String dataPath = text(config, "dataPath");
        String requestBody = text(config, "requestBody");
        String headersJson = text(config, "headers");
        String fileRefPath = text(config, "fileRefPath");
        String downloadUrl = text(config, "downloadUrl");
        Map<String, Object> params = req.params() == null ? Map.of() : req.params();
        // $P{fileType} in the endpoint resolves to the output format chosen on the run screen,
        // mapped to the document-service convention: PDF -> PDF, DOCX -> WORD, XLSX -> EXCEL.
        // A report that declares its own fileType run parameter keeps precedence.
        Map<String, Object> urlParams = params;
        if (req.format() != null && !req.format().isBlank() && !params.containsKey("fileType")) {
            urlParams = new java.util.LinkedHashMap<>(params);
            urlParams.put("fileType", fileTypeOf(req.format()));
        }
        String url = substitute(endpoint, urlParams);
        guardEndpoint(endpoint, url);
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder().uri(URI.create(url))
                    .timeout(requestTimeout).header("Accept", "application/json");
            // Edge SSO passthrough (opt-in via forwardEdgeToken) — forward the caller's token so a
            // gateway-fronted endpoint (e.g. /api/export) authorizes AS the signed-in user.
            maybeForwardEdgeToken(b, config, endpoint, req.callerToken());
            // Optional per-report auth/extra headers (e.g. Authorization / Cookie for endpoints behind login).
            applyHeaders(b, headersJson, params);
            // POST body: a fixed JSON template (requestBody, with $P{param} substituted and JSON-escaped)
            // when configured — needed for endpoints whose body is a nested object that a flat param map
            // can't express; otherwise the run params serialized as a flat JSON object (back-compat).
            String postBody = (requestBody != null && !requestBody.isBlank())
                    ? substituteJson(requestBody, params)
                    : mapper.writeValueAsString(params);
            HttpRequest hr = "POST".equalsIgnoreCase(method)
                    ? b.header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(postBody)).build()
                    : b.GET().build();
            HttpResponse<java.io.InputStream> resp = http.send(hr, HttpResponse.BodyHandlers.ofInputStream());
            if (resp.statusCode() / 100 != 2) {
                try (var body = resp.body()) { body.readAllBytes(); } // drain so the connection is released
                throw new RenderException("api engine: " + method + " " + url + " returned HTTP " + resp.statusCode());
            }
            // Two-step "download by reference": some export endpoints return a JSON envelope carrying a
            // REFERENCE to a rendered file, not the bytes — e.g. the component's
            // POST /component/v1/api/export/data → {body:{sourceFile:"..."}}. When fileRefPath + downloadUrl
            // are configured, pull the reference out and fetch the real artifact from downloadUrl ({ref} =
            // the reference, url-encoded; $P{param} also substituted), passing the bytes straight through.
            // This lets a report reuse a purpose-built (e.g. Aspose) export whose fidelity Jasper can't match.
            if (fileRefPath != null && !fileRefPath.isBlank() && downloadUrl != null && !downloadUrl.isBlank()) {
                JsonNode env;
                try (java.io.InputStream is = resp.body()) { env = mapper.readTree(is); }
                JsonNode refNode = navigate(env, fileRefPath);
                String ref = (refNode != null && refNode.isValueNode()) ? refNode.asText() : null;
                if (ref == null || ref.isBlank()) {
                    throw new RenderException("api engine: 2-step reference not found at '" + fileRefPath
                            + "' in the response envelope");
                }
                String dlUrl = substitute(downloadUrl.replace("{ref}",
                        URLEncoder.encode(ref, StandardCharsets.UTF_8)), urlParams);
                guardEndpoint(downloadUrl, dlUrl);
                HttpRequest.Builder db = HttpRequest.newBuilder().uri(URI.create(dlUrl))
                        .timeout(Duration.ofSeconds(120)).header("Accept", "*/*");
                maybeForwardEdgeToken(db, config, downloadUrl, req.callerToken());
                HttpResponse<java.io.InputStream> dresp =
                        http.send(db.GET().build(), HttpResponse.BodyHandlers.ofInputStream());
                if (dresp.statusCode() / 100 != 2) {
                    try (var body = dresp.body()) { body.readAllBytes(); }
                    throw new RenderException("api engine: 2-step download GET " + dlUrl
                            + " returned HTTP " + dresp.statusCode());
                }
                String dct = dresp.headers().firstValue("Content-Type").orElse("").toLowerCase();
                String dfmt = (req.format() == null ? "xlsx" : req.format()).toLowerCase();
                java.nio.file.Path tmp = java.nio.file.Files.createTempFile("rs-api2-", ".bin");
                try (java.io.InputStream is = dresp.body()) {
                    java.nio.file.Files.copy(is, tmp, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
                long size = java.nio.file.Files.size(tmp);
                log.info("api engine: 2-step download ({}) — passing through {} bytes as {}", dct, size, dfmt);
                return RenderResult.ofFile(tmp,
                        dct.isBlank() ? "application/octet-stream" : dct.split(";")[0].trim(), dfmt, size);
            }
            // Some endpoints (e.g. .../download?fileType=pdf) return a ready-made file rather than JSON
            // rows. Pass that straight through as the artifact instead of trying to parse it as a table.
            String ct = resp.headers().firstValue("Content-Type").orElse("").toLowerCase();
            boolean isJson = ct.isBlank() || ct.contains("json");
            // An XML response is DATA, not a file: parse it into a tree and render it as a table just like
            // JSON (same dataPath + toTabular). Without this the endpoint's raw .xml fell through to the
            // passthrough below and the user got an unrenderable xml file.
            // Match only *genuine* XML content types (text/xml, application/xml, application/...+xml).
            // Office Open XML files (xlsx/docx/pptx) carry mimetypes like
            // application/vnd.openxmlformats-officedocument.spreadsheetml.sheet whose string merely
            // CONTAINS "xml" (in "openxmlformats"/"spreadsheetml") but are binary ZIPs — they must fall
            // through to the binary passthrough below, not get parsed as XML.
            boolean isXml = ct.contains("/xml") || ct.contains("+xml");
            if (!isJson && isXml) {
                JsonNode xmlRoot;
                try (java.io.InputStream is = resp.body()) {
                    xmlRoot = xmlMapper.readTree(is);
                }
                TabularData xmlData = toTabular(navigate(xmlRoot, dataPath));
                return renderer.renderTabular(req, xmlData);
            }
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

    /** Map a run format to the $P{fileType} value: PDF -> PDF, DOCX -> WORD, XLSX -> EXCEL. */
    private static String fileTypeOf(String format) {
        String f = format.trim().toUpperCase();
        return switch (f) {
            case "DOCX" -> "WORD";
            case "XLSX" -> "EXCEL";
            default -> f;
        };
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

    /**
     * Replace $P{name} inside a JSON body template. Unlike {@link #substitute} (for URLs), the value is
     * JSON-string-escaped — NOT URL-encoded — so it stays valid when the placeholder sits inside a JSON
     * string literal (e.g. {@code "code":"$P{branchCode}"}). For a numeric field, leave the placeholder
     * unquoted in the template ({@code "param":$P{param}}) so the emitted value is a bare number.
     */
    private String substituteJson(String tpl, Map<String, Object> params) {
        Matcher m = P_PLACEHOLDER.matcher(tpl);
        StringBuilder out = new StringBuilder(tpl.length() + 16);
        int last = 0;
        while (m.find()) {
            out.append(tpl, last, m.start());
            Object v = params.get(m.group(1));
            if (v != null) {
                try {
                    String esc = mapper.writeValueAsString(v.toString()); // -> "escaped"
                    out.append(esc, 1, esc.length() - 1);                  // strip the quotes
                } catch (Exception e) { out.append(v); }
            }
            last = m.end();
        }
        out.append(tpl, last, tpl.length());
        return out.toString();
    }

    /**
     * Apply optional extra request headers from a JSON object (e.g. {@code {"Authorization":"Bearer $P{token}"}}).
     * Values get $P{param} substitution (un-encoded — a header value is a plain string). Lets a report call an
     * endpoint behind login by supplying an Authorization/Cookie header (typically via a run parameter so the
     * token isn't baked into the config).
     */
    private void applyHeaders(HttpRequest.Builder b, String headersJson, Map<String, Object> params) {
        if (headersJson == null || headersJson.isBlank()) return;
        JsonNode node;
        try {
            node = mapper.readTree(headersJson);
        } catch (Exception e) {
            throw new RenderException("api engine: invalid headers JSON: " + e.getMessage(), e);
        }
        if (!node.isObject()) throw new RenderException("api engine: headers must be a JSON object");
        node.fields().forEachRemaining(e -> b.header(e.getKey(), substitutePlain(e.getValue().asText(), params)));
    }

    /**
     * Forward the caller's edge (Keycloak) token to a gateway-fronted endpoint when the report opts in
     * ({@code forwardEdgeToken=true}). Sets BOTH the header the central oauth2-proxy validates
     * ({@code Authorization: Bearer}, via {@code --skip-jwt-bearer-tokens}) AND the one it injects for the
     * app ({@code X-Forwarded-Access-Token}, via {@code --pass-access-token}), so the report works whether
     * it targets the public edge URL (proxy re-derives and overwrites X-Forwarded-* itself) or the
     * in-cluster service directly (app reads X-Forwarded-Access-Token). Restricted to an allow-list of
     * host suffixes so a misconfigured endpoint can never exfiltrate a user's token to an arbitrary host.
     *
     * <p>The forwarded token is the CALLER's own edge token when present (a real user via the rs-export
     * button — audited as that person); otherwise it falls back to a configured service-account token
     * ({@link EdgeServiceTokenProvider}) so the report also runs from the admin Run Task screen, where the
     * caller holds only the app's rs.token and no Keycloak token exists. Nothing is forwarded if neither
     * is available.
     */
    private void maybeForwardEdgeToken(HttpRequest.Builder b, JsonNode config, String endpoint, String callerToken) {
        boolean optedIn = config.path("forwardEdgeToken").asBoolean(false)
                || "true".equalsIgnoreCase(text(config, "forwardEdgeToken"));
        if (!optedIn) return;
        String token = (callerToken != null && !callerToken.isBlank()) ? callerToken : serviceTokens.getToken();
        if (token == null || token.isBlank()) return;
        String host;
        try { host = URI.create(endpoint).getHost(); } catch (Exception e) { host = null; }
        if (host == null || !hostAllowedForToken(host)) {
            log.warn("api engine: forwardEdgeToken is set but endpoint host '{}' is not in the "
                    + "token-forward allow-list {} — NOT forwarding a token", host, tokenForwardHostSuffixes);
            return;
        }
        b.header("Authorization", "Bearer " + token);
        b.header("X-Forwarded-Access-Token", token);
    }

    /** True if {@code host} equals or is a subdomain of any configured allow-list suffix (case-insensitive). */
    private boolean hostAllowedForToken(String host) {
        String h = host.toLowerCase();
        for (String raw : tokenForwardHostSuffixes) {
            String s = raw.toLowerCase();
            if (h.equals(s)) return true;
            String dotted = s.startsWith(".") ? s : "." + s;
            if (h.endsWith(dotted)) return true;
        }
        return false;
    }

    /** Replace $P{name} with the raw (un-encoded, un-escaped) run-parameter value — for header values. */
    private static String substitutePlain(String tpl, Map<String, Object> params) {
        Matcher m = P_PLACEHOLDER.matcher(tpl);
        StringBuilder out = new StringBuilder(tpl.length() + 16);
        int last = 0;
        while (m.find()) {
            out.append(tpl, last, m.start());
            Object v = params.get(m.group(1));
            out.append(v == null ? "" : v.toString());
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
