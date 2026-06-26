package io.reporthub.reportstudio.engine.remote;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.engine.EngineConfig;
import io.reporthub.reportstudio.engine.EngineProp;
import io.reporthub.reportstudio.engine.ReportEngine;
import io.reporthub.reportstudio.render.RenderException;
import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Built-in <b>fetch</b> engine — downloads a ready-made file from an HTTP endpoint and stores it,
 * for back-ends (e.g. the OneWeb component service) that PRODUCE a file rather than rows.
 *
 * <p>Two modes, both configured per report in the render unit's {@code configJson}; the response is
 * streamed straight to a temp file (never buffered in heap) so large PDFs land in MinIO, not OOM:
 * <ul>
 *   <li><b>1-step</b> (set {@code downloadUrl} only): {@code GET downloadUrl} → store. {@code $P{name}}
 *       in the URL is substituted (URL-encoded) from run params, so an id supplied at run time works:
 *       {@code .../v3/document/summary/file?id=$P{docId}&fileType=PDF}.</li>
 *   <li><b>2-step</b> (also set {@code generateUrl}): {@code POST generateUrl} (body = {@code generateBody}
 *       or the run params as JSON) → read the id at {@code idPath} from the JSON response → substitute it
 *       into {@code downloadUrl} as {@code {id}} → GET → store. For "combined book" where the id is
 *       generated each time.</li>
 * </ul>
 * Local engine ({@link #requiresInstance()} false) — no install needed. An optional Bearer token may be
 * set in {@code configJson.authToken} for endpoints that require auth (the OneWeb download-by-id needs
 * none). The endpoint host must be fixed; {@code $P{...}} is only allowed in the path/query (SSRF guard).
 */
@Component
public class FetchEngine implements ReportEngine {

    public static final String KIND = "fetch";
    private static final Logger log = LoggerFactory.getLogger(FetchEngine.class);
    private static final Pattern P_PLACEHOLDER = Pattern.compile("\\$P!?\\{([^}]+)\\}");
    /** idPath array selector: [FIELD=value] picks the FIRST array element whose FIELD equals value. */
    private static final Pattern ARRAY_FILTER = Pattern.compile("\\[([^=\\]]+)=([^\\]]*)\\]");

    private final ObjectMapper mapper;
    private final long maxBytes;
    private final long downloadTimeoutSeconds;
    private final HttpClient http;

    public FetchEngine(ObjectMapper kafkaObjectMapper,
                       @Value("${app.engine.remote.max-bytes:0}") long maxBytes,
                       @Value("${app.engine.remote.download-timeout-seconds:600}") long downloadTimeoutSeconds,
                       @Value("${app.engine.remote.insecure-tls:false}") boolean insecureTls) {
        this.mapper = kafkaObjectMapper;
        this.maxBytes = maxBytes;
        this.downloadTimeoutSeconds = downloadTimeoutSeconds;
        this.http = InsecureTls.client(insecureTls, Duration.ofSeconds(15));
    }

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public String label() {
        return "HTTP fetch (download file)";
    }

    @Override
    public List<EngineProp> reportProps() {
        return List.of(
                new EngineProp("downloadUrl", "Download URL", "url", true,
                        "https://host/component/v3/document/summary/file?id=$P{docId}&fileType=PDF",
                        "GET URL of the file. $P{param} = run params (URL-encoded); {id} = id from the generate step.",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("generateUrl", "Generate URL (2-step)", "url", false,
                        "https://host/component/v1/api/export/data",
                        "Optional. If set, POST here first; the response's id is put into downloadUrl as {id}.",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("generateBody", "Generate body (JSON)", "textarea", false,
                        "{\"app\":\"...\",\"elements\":[...]}",
                        "Optional JSON body for the generate POST ($P{param} substituted). Blank = run params as JSON.",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("idPath", "Id path in response", "text", false, "id",
                        "dot-path to the id in the generate response, e.g. data.id (default: id)",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("preGenerateUrl", "Pre-generate URL (3-step)", "url", false,
                        "https://host/example-app/microflow/service",
                        "Optional. If set, POST this BEFORE generate to kick off an async build (id is read from generate, not from here).",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("preGenerateBody", "Pre-generate body (JSON)", "textarea", false,
                        "{\"flowName\":\"saveBPN0501SC0300\",\"...\":\"...\"}",
                        "Optional JSON body for the pre-generate POST ($P{param} substituted).",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("pollIntervalSeconds", "Poll interval (seconds)", "number", false, "30",
                        "If set together with pollTimeoutMinutes, the generate step is retried this often until the id appears (use with idPath filters like [STATUS=Success]).",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("pollTimeoutMinutes", "Poll timeout (minutes)", "number", false, "30",
                        "Stop polling after this many minutes and fail. Max 60.",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("authToken", "Bearer token", "password", false, "",
                        "Optional Bearer token sent on every call (download-by-id usually needs none).",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("downloadAsync", "Async download", "boolean", false, "false",
                        "If true, the download step calls <downloadUrl>/async (POST) → jobId, polls <downloadUrl>/status?jobId until DONE, then GETs <downloadUrl>/result?jobId — instead of one long blocking GET. For back-ends that generate slowly (multi-section docs).",
                        List.of(), EngineProp.UNIT_CONFIG_JSON));
    }

    @Override
    public RenderResult render(RenderRequest req, EngineConfig cfg) {
        JsonNode config;
        try {
            config = (req.configJson() == null || req.configJson().isBlank())
                    ? mapper.createObjectNode() : mapper.readTree(req.configJson());
        } catch (Exception e) {
            throw new RenderException("fetch engine: invalid config JSON: " + e.getMessage(), e);
        }
        String downloadTpl = text(config, "downloadUrl");
        if (downloadTpl == null || downloadTpl.isBlank()) {
            throw new RenderException("fetch engine: downloadUrl is required");
        }
        String generateTpl = text(config, "generateUrl");
        String idPath = text(config, "idPath");
        String authToken = text(config, "authToken");
        String preGenerateTpl = text(config, "preGenerateUrl");
        String preGenerateBodyTpl = text(config, "preGenerateBody");
        boolean downloadAsync = "true".equalsIgnoreCase(text(config, "downloadAsync"));
        long pollIntervalMs = parseLongOr(text(config, "pollIntervalSeconds"), 0) * 1000L;
        long pollTimeoutMs = Math.min(parseLongOr(text(config, "pollTimeoutMinutes"), 0), 60) * 60_000L;
        boolean polling = pollIntervalMs > 0 && pollTimeoutMs > 0;
        Map<String, Object> params = req.params() == null ? Map.of() : req.params();

        String reportTag = req.code() == null ? "?" : req.code();
        log.info("[fetch:{}] start mode={} polling={}{}", reportTag,
                preGenerateTpl != null && !preGenerateTpl.isBlank() ? "3-step"
                        : generateTpl != null && !generateTpl.isBlank() ? "2-step" : "1-step",
                polling, polling ? " (every " + (pollIntervalMs / 1000) + "s, up to " + (pollTimeoutMs / 60_000) + " min)" : "");

        java.nio.file.Path tmp = null;
        try {
            // --- step 0 (optional): pre-generate (kick off an async build whose
            // build_final_id only later appears in the generate response, e.g.
            // OneWeb's saveBPN0501SC0300 → loadBPN0501SC0300 flow).
            if (preGenerateTpl != null && !preGenerateTpl.isBlank()) {
                log.info("[fetch:{}] pre-generate POST {}", reportTag, substitute(preGenerateTpl, params));
                postJson(preGenerateTpl, preGenerateBodyTpl, params, authToken, "pre-generate");
                log.info("[fetch:{}] pre-generate OK", reportTag);
            }

            // --- step 1 (optional): generate -> id, with optional poll-until-found ---
            String id = null;
            if (generateTpl != null && !generateTpl.isBlank()) {
                long deadline = polling ? System.currentTimeMillis() + pollTimeoutMs : 0;
                int attempt = 0;
                while (true) {
                    attempt++;
                    log.info("[fetch:{}] generate POST {} (attempt {})", reportTag, substitute(generateTpl, params), attempt);
                    JsonNode root = postJson(generateTpl, text(config, "generateBody"), params, authToken, "generate");
                    JsonNode idNode = navigate(root, (idPath == null || idPath.isBlank()) ? "id" : idPath);
                    id = idNode == null || idNode.isNull() ? null : idNode.asText();
                    if (id != null && !id.isBlank()) {
                        log.info("[fetch:{}] generate found id={} at '{}' on attempt {}", reportTag, id, idPath, attempt);
                        break;
                    }
                    if (!polling) {
                        throw new RenderException("fetch engine: no id at '" + idPath + "' in the generate response");
                    }
                    if (System.currentTimeMillis() >= deadline) {
                        throw new RenderException("fetch engine: id at '" + idPath
                                + "' did not appear within the poll timeout (" + attempt + " attempts)");
                    }
                    String diag = pollDiag(root, idPath);
                    log.info("[fetch:{}] generate: no id at '{}' yet{} — sleeping {}s then retrying",
                            reportTag, idPath, diag.isEmpty() ? "" : " (" + diag + ")", pollIntervalMs / 1000);
                    Thread.sleep(pollIntervalMs);
                }
            }

            // --- step 2: download the file ---
            String downloadUrl = substitute(downloadTpl, params);
            if (id != null) {
                downloadUrl = downloadUrl.replace("{id}", URLEncoder.encode(id, StandardCharsets.UTF_8));
            }
            guardUrl(downloadTpl, downloadUrl);

            String fmt = (req.format() == null ? "pdf" : req.format()).toLowerCase();
            // Stream to a temp file so a large file lands in MinIO instead of OOM-killing the pod.
            tmp = java.nio.file.Files.createTempFile("rs-fetch-", ".bin");
            String contentType;
            if (downloadAsync) {
                // Async back-end: POST .../async → {jobId} (cuid), poll .../status?jobId until DONE,
                // then GET .../result?jobId. Avoids holding one multi-minute HTTP connection open.
                contentType = fetchAsync(downloadUrl, authToken, reportTag, tmp, fmt,
                        pollIntervalMs > 0 ? pollIntervalMs : 5000L);
            } else {
                log.info("[fetch:{}] download GET {}", reportTag, downloadUrl);
                // Synchronous back-ends (e.g. OneWeb component) GENERATE the document during this GET,
                // which for heavy multi-section reports can take several minutes — so this read timeout
                // must be generous (configurable; default 10 min), well above the 120s that used to clip it.
                HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(downloadUrl))
                        .timeout(Duration.ofSeconds(downloadTimeoutSeconds))
                        .header("Accept", "*/*")
                        .GET();
                if (authToken != null && !authToken.isBlank()) rb.header("Authorization", "Bearer " + authToken);
                HttpResponse<java.nio.file.Path> res = http.send(rb.build(), HttpResponse.BodyHandlers.ofFile(tmp));
                if (res.statusCode() / 100 != 2) {
                    throw new RenderException("fetch engine: download returned HTTP " + res.statusCode());
                }
                contentType = res.headers().firstValue("Content-Type").orElse(contentTypeFor(fmt));
            }
            long size = java.nio.file.Files.size(tmp);
            log.info("[fetch:{}] download OK ({} bytes)", reportTag, size);
            if (maxBytes > 0 && size > maxBytes) {
                throw new RenderException("fetch engine: file (" + size + " bytes) exceeds the limit of " + maxBytes);
            }
            RenderResult result = RenderResult.ofFile(tmp, contentType, fmt, size);
            tmp = null; // ownership handed to RenderWorker
            return result;
        } catch (RenderException re) {
            throw re;
        } catch (Exception e) {
            throw new RenderException("fetch engine call failed: " + e.getMessage(), e);
        } finally {
            if (tmp != null) { try { java.nio.file.Files.deleteIfExists(tmp); } catch (Exception ignore) { } }
        }
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    private static long parseLongOr(String s, long fallback) {
        if (s == null || s.isBlank()) return fallback;
        try { return Long.parseLong(s.trim()); }
        catch (NumberFormatException e) { return fallback; }
    }

    /**
     * Shared POST helper: substitute the body, POST it, parse the JSON response, and surface a
     * stage-tagged error on a non-2xx ({@code stage} = "generate" / "pre-generate"). Returns the
     * parsed JSON; pre-generate's caller just discards it.
     */
    private JsonNode postJson(String urlTpl, String bodyTpl, Map<String, Object> params,
                              String authToken, String stage) throws Exception {
        String url = substitute(urlTpl, params);
        guardUrl(urlTpl, url);
        String body = (bodyTpl != null && !bodyTpl.isBlank())
                ? substituteJson(bodyTpl, params)
                : mapper.writeValueAsString(params);
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(120))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body));
        if (authToken != null && !authToken.isBlank()) b.header("Authorization", "Bearer " + authToken);
        HttpResponse<java.io.InputStream> r = http.send(b.build(), HttpResponse.BodyHandlers.ofInputStream());
        JsonNode root;
        try (java.io.InputStream is = r.body()) { root = mapper.readTree(is); }
        if (r.statusCode() / 100 != 2) {
            throw new RenderException("fetch engine: " + stage + " returned HTTP " + r.statusCode());
        }
        return root;
    }

    /** Replace $P{name} with URL-encoded run-parameter values. */
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
     * string literal (e.g. {@code "doc_build_id":"$P{docBuildId}"}). The placeholder must already be
     * quoted in the template; only the inner value is emitted (surrounding quotes stripped).
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

    /** SSRF guard: require http(s) and forbid $P{...} in the authority (host must be fixed). */
    private static void guardUrl(String template, String finalUrl) {
        URI uri;
        try { uri = URI.create(finalUrl); }
        catch (Exception e) { throw new RenderException("fetch engine: invalid URL after substitution"); }
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            throw new RenderException("fetch engine: URL must use http or https");
        }
        int sep = template.indexOf("://");
        if (sep >= 0) {
            String afterScheme = template.substring(sep + 3);
            int authEnd = afterScheme.length();
            for (char delim : new char[] {'/', '?', '#'}) {
                int i = afterScheme.indexOf(delim);
                if (i >= 0 && i < authEnd) authEnd = i;
            }
            if (afterScheme.substring(0, authEnd).contains("$P")) {
                throw new RenderException("fetch engine: the host must be fixed — $P{...} is only allowed in the path/query");
            }
        }
    }

    /**
     * Walk a dot-path into the response to the id. Two extras beyond a plain dot-path, because real
     * back-ends nest awkwardly (OneWeb's microflow double-encodes its payload as JSON-inside-a-string):
     * <ul>
     *   <li><b>Auto-unwrap</b>: if the current node is a JSON string, it is parsed as JSON before the
     *       next segment is applied — so {@code a.b.c} transparently descends through string-encoded JSON
     *       at {@code a} or {@code b}.</li>
     *   <li><b>Array index</b>: a numeric segment indexes into an array, e.g.
     *       {@code ...dataList.0.BUILD_FINAL_ID} takes the first (latest) element.</li>
     *   <li><b>Array filter</b>: {@code [FIELD=value]} picks the first array element whose FIELD equals
     *       value, e.g. {@code ...dataList.[STATUS=Success].BUILD_FINAL_ID} takes the latest COMPLETED
     *       build (the list is sorted newest-first) and skips ones still {@code Processing}.</li>
     * </ul>
     */
    private JsonNode navigate(JsonNode root, String path) {
        if (path == null || path.isBlank()) return root;
        JsonNode n = root;
        for (String seg : path.split("\\.")) {
            if (n == null) return null;
            seg = seg.trim();
            if (seg.isEmpty()) continue;
            if (n.isTextual()) { // value is JSON embedded as a string — parse before descending
                try { n = mapper.readTree(n.asText()); } catch (Exception ignore) { return null; }
            }
            Matcher fm = ARRAY_FILTER.matcher(seg);
            if (fm.matches() && n.isArray()) {
                String field = fm.group(1).trim(), val = fm.group(2).trim();
                JsonNode match = null;
                for (JsonNode el : n) {
                    JsonNode fv = el.get(field);
                    if (fv != null && val.equals(fv.asText())) { match = el; break; }
                }
                n = match;
            } else {
                n = (seg.matches("\\d+") && n.isArray()) ? n.get(Integer.parseInt(seg)) : n.get(seg);
            }
        }
        return n;
    }

    /**
     * Async download against a back-end that mints a job and generates in the background:
     * {@code POST <base>/async?<query>} → {@code {"jobId": "..."}}, then poll {@code GET <base>/status?jobId=}
     * until {@code DONE} (or {@code ERROR}/timeout), then {@code GET <base>/result?jobId=} streamed to {@code tmp}.
     * {@code base} is the download URL's path up to {@code ?} (e.g. {@code .../v3/document/summary/file}); the
     * original query (id, fileType) is forwarded to {@code /async}. Returns the result's Content-Type.
     */
    private String fetchAsync(String downloadUrl, String authToken, String reportTag,
                              java.nio.file.Path tmp, String fmt, long pollIntervalMs) throws Exception {
        int q = downloadUrl.indexOf('?');
        String base = q >= 0 ? downloadUrl.substring(0, q) : downloadUrl;
        String query = q >= 0 ? downloadUrl.substring(q + 1) : "";
        String asyncUrl = base + "/async" + (query.isEmpty() ? "" : "?" + query);

        log.info("[fetch:{}] async start POST {}", reportTag, asyncUrl);
        HttpRequest.Builder sb = HttpRequest.newBuilder(URI.create(asyncUrl))
                .timeout(Duration.ofSeconds(30)).header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.noBody());
        if (authToken != null && !authToken.isBlank()) sb.header("Authorization", "Bearer " + authToken);
        HttpResponse<String> startRes = http.send(sb.build(), HttpResponse.BodyHandlers.ofString());
        if (startRes.statusCode() / 100 != 2) {
            throw new RenderException("fetch engine: async start returned HTTP " + startRes.statusCode());
        }
        String jobId = mapper.readTree(startRes.body()).path("jobId").asText(null);
        if (jobId == null || jobId.isBlank()) {
            throw new RenderException("fetch engine: async start did not return a jobId: " + startRes.body());
        }
        log.info("[fetch:{}] async jobId={}", reportTag, jobId);

        String statusUrl = base + "/status?jobId=" + URLEncoder.encode(jobId, StandardCharsets.UTF_8);
        String resultUrl = base + "/result?jobId=" + URLEncoder.encode(jobId, StandardCharsets.UTF_8);
        long interval = Math.max(2000L, pollIntervalMs);
        long deadline = System.currentTimeMillis() + downloadTimeoutSeconds * 1000L;
        int attempt = 0;
        while (true) {
            Thread.sleep(interval);
            attempt++;
            HttpRequest.Builder stb = HttpRequest.newBuilder(URI.create(statusUrl))
                    .timeout(Duration.ofSeconds(30)).header("Accept", "application/json").GET();
            if (authToken != null && !authToken.isBlank()) stb.header("Authorization", "Bearer " + authToken);
            HttpResponse<String> st = http.send(stb.build(), HttpResponse.BodyHandlers.ofString());
            String status = mapper.readTree(st.body()).path("status").asText("UNKNOWN");
            if ("DONE".equals(status)) {
                log.info("[fetch:{}] async DONE jobId={} after {} polls", reportTag, jobId, attempt);
                break;
            }
            if ("ERROR".equals(status)) {
                throw new RenderException("fetch engine: async generation failed: "
                        + mapper.readTree(st.body()).path("error").asText(""));
            }
            if ("UNKNOWN".equals(status)) {
                throw new RenderException("fetch engine: async jobId not found (expired?): " + jobId);
            }
            if (System.currentTimeMillis() >= deadline) {
                throw new RenderException("fetch engine: async generation did not finish within "
                        + downloadTimeoutSeconds + "s (" + attempt + " polls)");
            }
            if (attempt % 6 == 0) {
                log.info("[fetch:{}] async still {} jobId={} ({} polls)", reportTag, status, jobId, attempt);
            }
        }

        log.info("[fetch:{}] async result GET {}", reportTag, resultUrl);
        HttpRequest.Builder gb = HttpRequest.newBuilder(URI.create(resultUrl))
                .timeout(Duration.ofSeconds(downloadTimeoutSeconds)).header("Accept", "*/*").GET();
        if (authToken != null && !authToken.isBlank()) gb.header("Authorization", "Bearer " + authToken);
        HttpResponse<java.nio.file.Path> gr = http.send(gb.build(), HttpResponse.BodyHandlers.ofFile(tmp));
        if (gr.statusCode() / 100 != 2) {
            throw new RenderException("fetch engine: async result returned HTTP " + gr.statusCode());
        }
        return gr.headers().firstValue("Content-Type").orElse(contentTypeFor(fmt));
    }

    /**
     * Why is the poll not finding the id? Almost always because the {@code [FIELD=value]} filter matches
     * nothing yet — the back-end's rows are still {@code Processing}, or failed. Walk to the array the
     * filter selects from and tabulate that field's values, e.g. {@code "7 rows; STATUS: Processing×7"},
     * so a stuck run is diagnosable from the log alone instead of probing the back-end by hand. Best-effort:
     * returns "" if the idPath has no array filter or the array can't be reached.
     */
    private String pollDiag(JsonNode root, String idPath) {
        try {
            if (idPath == null || idPath.isBlank()) return "";
            String[] segs = idPath.split("\\.");
            int filterIdx = -1;
            String field = null;
            for (int i = 0; i < segs.length; i++) {
                Matcher m = ARRAY_FILTER.matcher(segs[i].trim());
                if (m.matches()) { filterIdx = i; field = m.group(1).trim(); break; }
            }
            if (filterIdx < 0) return "";
            JsonNode arr = navigate(root, String.join(".", Arrays.copyOfRange(segs, 0, filterIdx)));
            if (arr == null || !arr.isArray()) return "";
            Map<String, Integer> counts = new LinkedHashMap<>();
            for (JsonNode el : arr) {
                JsonNode fv = el.get(field);
                counts.merge(fv == null || fv.isNull() ? "(missing)" : fv.asText(), 1, Integer::sum);
            }
            StringBuilder sb = new StringBuilder(arr.size() + " rows; " + field + ": ");
            boolean first = true;
            for (Map.Entry<String, Integer> e : counts.entrySet()) {
                if (!first) sb.append(", ");
                sb.append(e.getKey()).append("×").append(e.getValue());
                first = false;
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static String contentTypeFor(String fmt) {
        return switch (fmt) {
            case "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "csv" -> "text/csv";
            case "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            default -> "application/pdf";
        };
    }
}
