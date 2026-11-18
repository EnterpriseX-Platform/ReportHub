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
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * <p><b>Built-in default:</b> with no {@code baseUrl} the engine exports a ReportHub document (Documents
 * section) through the bundled exporter ({@code engines/document-exporter}, {@code app.documents.exporter-url}),
 * so {@code docId} is simply the document id shown in the Documents editor URL.
 *
 * Built-in <b>document-builder</b> engine — binds a report to a book in an external <b>document-builder</b>
 * authoring app, instead of a template or a query.
 *
 * <p>A report on this engine is <i>composed</i>, not parameterised: opening it in Run Task embeds
 * the document builder's own editor ({@code {baseUrl}/doc/{docId}} — section tree, per-section form, live preview)
 * rather than the parameter form, so the same screen the users already know is reachable from Report
 * Studio. This engine is the server-side half: it renders by calling the very endpoint the document builder's own
 * "Export PDF" button calls, {@code GET {baseUrl}/api/export/pdf/{docId}}, and passes the bytes
 * through — so a scheduled run, the rs-export button and the editor's own button all produce the
 * identical book (the document builder's exporter renders and version-caches it; see its {@code exporter/server.js}).
 *
 * <p>Configured per report in the render unit's {@code configJson}:
 * {@code {"baseUrl":"https://docs.example.com/doc-builder","docId":"doc-123"}}.
 * {@code docId} is whatever the users know the book by — normally the publicId from the editor URL,
 * which Run Task frames verbatim; the export resolves it to the numeric id the exporter requires.
 * Local engine ({@link #requiresInstance()} false) — no install needed. PDF only: the document builder's exporter
 * dropped DOCX, so any other requested format is refused rather than silently mislabelled.
 */
@Component
public class DocBuilderEngine implements ReportEngine {

    public static final String KIND = "docbuilder";
    private static final Logger log = LoggerFactory.getLogger(DocBuilderEngine.class);
    private static final Pattern P_PLACEHOLDER = Pattern.compile("\\$P!?\\{([^}]+)\\}");

    private final ObjectMapper mapper;
    private final long exportTimeoutSeconds;
    private final HttpClient http;
    /** Host suffixes the caller's edge token may be forwarded to — the same exfiltration guard the api engine uses. */
    private final List<String> tokenForwardHostSuffixes;
    /** Mints a service-account token for runs that carry no edge token (the admin Run Task screen / a scheduler). */
    private final EdgeServiceTokenProvider serviceTokens;
    /** The bundled document exporter, used when a report sets no baseUrl. */
    private final String builtinExporterUrl;
    /**
     * Signs the print token for built-in documents: the job's tenant/project and the principal the
     * render worker runs as (the user who submitted the job), so the exported data matches what that
     * user sees on screen. Optional so the engine can be built without it.
     */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.document.DocumentPrintTokens printTokens;

    public DocBuilderEngine(ObjectMapper objectMapper,
                            EdgeServiceTokenProvider serviceTokens,
                            @Value("${app.engine.docbuilder.export-timeout-seconds:600}") long exportTimeoutSeconds,
                            @Value("${app.engine.api.token-forward-host-suffixes:.example.com,.svc.cluster.local,localhost}") String tokenForwardHosts,
                            @Value("${app.engine.remote.insecure-tls:false}") boolean insecureTls,
                            @Value("${app.documents.exporter-url:http://localhost:3200}") String builtinExporterUrl) {
        this.builtinExporterUrl = trimTrailingSlash(builtinExporterUrl);
        this.mapper = objectMapper;
        this.serviceTokens = serviceTokens;
        this.exportTimeoutSeconds = exportTimeoutSeconds;
        this.tokenForwardHostSuffixes = java.util.Arrays.stream(tokenForwardHosts.split(","))
                .map(String::trim).filter(s -> !s.isEmpty()).toList();
        this.http = InsecureTls.client(insecureTls, Duration.ofSeconds(15));
    }

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public String label() {
        return "Document builder";
    }

    @Override
    public List<EngineProp> reportProps() {
        return List.of(
                new EngineProp("baseUrl", "Document builder base URL", "url", false,
                        "https://docs.example.com/doc-builder",
                        "Optional. Leave blank to export a built-in ReportHub document through the bundled "
                                + "document exporter. Otherwise the base URL of an external document-builder app, no trailing slash. This is the BROWSER-facing "
                                + "address: Run Task embeds the editor at {baseUrl}/doc/{docId}. It is also used "
                                + "for the server-side export unless exportBaseUrl overrides it.",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("exportBaseUrl", "Export base URL (server-side)", "url", false,
                        "http://document-exporter:8080",
                        "Optional. Address THIS SERVER uses for the export + id lookup, when it differs from "
                                + "the browser-facing baseUrl. Point it at the in-cluster doc builder service to bypass "
                                + "the edge gateway, whose ~30-60s timeout returns 502 for a big book that takes "
                                + "minutes to render — the engine's own timeout then actually applies and the job "
                                + "finishes on the queue. Leave blank to export via baseUrl.",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("docId", "Document id", "text", true, "doc-123",
                        "The book's CUID2 publicId (as in the editor URL …/doc/<id>) or its numeric id. The "
                                + "editor is opened with this value VERBATIM; for the export the engine first "
                                + "resolves a publicId to the numeric id, because the document builder's exporter renders "
                                + "/print/<numeric id> and matches digits only. $P{param} is substituted from the "
                                + "run parameters, so a report may take the book id at run time instead of pinning one.",
                        List.of(), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("forwardEdgeToken", "Forward caller's SSO token", "select", false, "true",
                        "The document builder normally sits behind the edge gateway, which answers an unauthenticated "
                                + "export with 403 — so this defaults to ON (unlike the general-purpose api engine, "
                                + "whose endpoint can point anywhere). The signed-in user's edge (Keycloak) token is "
                                + "sent as Authorization / X-Forwarded-Access-Token, falling back to the configured "
                                + "service account when a run carries none. Only ever sent to the allow-listed hosts. "
                                + "Set false when baseUrl is an in-cluster address that needs no auth.",
                        List.of("true", "false"), EngineProp.UNIT_CONFIG_JSON),
                new EngineProp("exportTimeoutSeconds", "Export timeout (seconds)", "number", false, "",
                        "How long to wait for the document builder to finish RENDERING this book, counted from the moment the "
                                + "exporter picks the job up — time spent waiting in the exporter queue is not "
                                + "charged to it. A thick book needs more than the server-wide "
                                + "default of 600s. Leave blank to use that default. Max 3600.",
                        List.of(), EngineProp.UNIT_CONFIG_JSON));
    }

    @Override
    public RenderResult render(RenderRequest req, EngineConfig cfg) {
        JsonNode config;
        try {
            config = (req.configJson() == null || req.configJson().isBlank())
                    ? mapper.createObjectNode() : mapper.readTree(req.configJson());
        } catch (Exception e) {
            throw new RenderException("docbuilder engine: invalid config JSON: " + e.getMessage(), e);
        }
        String baseUrl = trimTrailingSlash(text(config, "baseUrl"));
        boolean builtin = baseUrl == null || baseUrl.isBlank();
        if (builtin) {
            // Built-in Documents: talk to the bundled exporter directly (in-cluster, no edge token).
            baseUrl = builtinExporterUrl;
            com.fasterxml.jackson.databind.node.ObjectNode on = config.isObject()
                    ? (com.fasterxml.jackson.databind.node.ObjectNode) config.deepCopy() : mapper.createObjectNode();
            on.put("forwardEdgeToken", "false");
            config = on;
        }
        Map<String, Object> params = req.params() == null ? Map.of() : req.params();
        String docId = substitute(text(config, "docId"), params);
        if (docId == null || docId.isBlank()) {
            throw new RenderException("docbuilder engine: docId is required "
                    + "(the book's publicId or numeric id in the document builder)");
        }
        String fmt = req.format() == null || req.format().isBlank() ? "PDF" : req.format().trim();
        if (!"PDF".equalsIgnoreCase(fmt)) {
            throw new RenderException("docbuilder engine: the document builder exports PDF only — '" + fmt + "' is not available");
        }
        // baseUrl is the BROWSER-facing address (what Run Task frames). The server-side calls may need a
        // different one: going through the public edge, its ~30-60s gateway timeout returns 502 for a book
        // that renders for minutes, no matter how patient this engine is. exportBaseUrl points those calls
        // at the in-cluster service instead, so exportTimeoutSeconds is the only limit that applies.
        String exportBase = trimTrailingSlash(text(config, "exportBaseUrl"));
        if (exportBase == null || exportBase.isBlank()) exportBase = baseUrl;
        guardUrl(exportBase, exportBase + "/api/export/pdf/");

        String reportTag = req.code() == null ? "?" : req.code();
        // The two the document builder paths disagree on what an id is: the editor resolves either form, but the
        // exporter renders /print/<id> whose route matches DIGITS ONLY — a publicId there would never
        // become ready and would hang until the read timeout. So the config keeps whatever the users
        // know the book by (normally the publicId from the editor URL, which is what Run Task frames),
        // and the export resolves it to the numeric id first.
        String exportId = docId.matches("\\d+")
                ? docId
                : resolveNumericId(exportBase, docId, config, req.callerToken(), reportTag);
        java.nio.file.Path tmp = null;
        try {
            // Stream to a temp file: a whole book can run to hundreds of pages, and the worker uploads
            // it to MinIO by path — keeping it off the heap.
            tmp = java.nio.file.Files.createTempFile("rs-docbuilder-", ".pdf");
            // The synchronous GET /api/export/pdf/{id} blocks until rendering finishes, and the
            // a proxy in front of the doc builder may cap reads at a few minutes. The exporter renders one job at a time, so when several
            // heavy books are requested together the queued ones hit 504 at 5 minutes even though each
            // renders in about a minute. The exporter's async route returns a jobId immediately, so every
            // request stays short and never hits that cap.
            String printToken = null;
            if (builtin && printTokens != null) {
                if (!exportId.matches("\\d+")) {
                    throw new RenderException("docbuilder engine: built-in documents are addressed by numeric id, got '" + docId + "'");
                }
                printToken = printTokens.mint(Long.parseLong(exportId));
            }
            long size = exportAsync(exportBase, exportId, docId, config, req.callerToken(), reportTag, tmp, printToken);
            log.info("[docbuilder:{}] export OK ({} bytes)", reportTag, size);
            RenderResult result = RenderResult.ofFile(tmp, "application/pdf", "pdf", size);
            tmp = null; // ownership handed to RenderWorker
            return result;
        } catch (RenderException re) {
            throw re;
        } catch (Exception e) {
            throw new RenderException("docbuilder engine export failed: " + e.getMessage(), e);
        } finally {
            if (tmp != null) { try { java.nio.file.Files.deleteIfExists(tmp); } catch (Exception ignore) { } }
        }
    }

    /**
     * Resolve a CUID2 publicId to the numeric document id the exporter needs, via the document builder's
     * {@code GET /api/documents/{ref}} (its {@code findByRef} accepts either form and answers with
     * both). Carries the same edge token as the export, since the lookup sits behind the same gateway.
     */
    /**
     * Render-time limit for this book: configurable per book, otherwise the server default; capped at 1 hour.
     */
    private long renderLimitSeconds(JsonNode config) {
        String raw = text(config, "exportTimeoutSeconds");
        if (raw == null || raw.isBlank()) return exportTimeoutSeconds;
        try {
            long v = Long.parseLong(raw.trim());
            return v <= 0 ? exportTimeoutSeconds : Math.min(v, 3600L);
        } catch (NumberFormatException e) {
            return exportTimeoutSeconds;
        }
    }

    /**
     * Export the PDF via the exporter's async route and wait for the job to finish.
     *
     * <p>The route returns a {@code jobId} immediately and is then polled, so every request stays
     * short and never hits the proxy read timeout on {@code /api/export/}. A single blocking GET would
     * instead have queued books cut off with HTTP 504 before they even start rendering.
     *
     * @return size of the file written to {@code dest}
     */
    private long exportAsync(String exportBase, String exportId, String docId, JsonNode config,
                             String callerToken, String reportTag, java.nio.file.Path dest, String printToken)
            throws Exception {
        String submitUrl = exportBase + "/api/export/pdf/"
                + URLEncoder.encode(exportId, StandardCharsets.UTF_8) + "/jobs";
        log.info("[docbuilder:{}] export POST {}", reportTag, submitUrl);
        if (printToken != null) submitUrl += "?t=" + URLEncoder.encode(printToken, StandardCharsets.UTF_8);
        HttpRequest.Builder sb = HttpRequest.newBuilder(URI.create(submitUrl))
                .timeout(Duration.ofSeconds(60))
                .header("Accept", "application/json");
        maybeForwardEdgeToken(sb, config, exportBase, callerToken);
        HttpResponse<String> sres = http.send(
                sb.POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
        if (sres.statusCode() / 100 != 2) {
            throw new RenderException("docbuilder engine: export returned HTTP " + sres.statusCode()
                    + " for document '" + docId + "'");
        }
        String jobId = mapper.readTree(sres.body()).path("jobId").asText(null);
        if (jobId == null || jobId.isBlank()) {
            throw new RenderException("docbuilder engine: exporter did not return a jobId for document '"
                    + docId + "'");
        }

        String statusUrl = exportBase + "/api/export/jobs/" + URLEncoder.encode(jobId, StandardCharsets.UTF_8);
        // The exporter renders strictly one job at a time, so with several heavy books queued the later
        // ones sit in "queued" for a long time before their own render starts. Counting queue time
        // against the render limit would kill them even though each takes a minute, so there are two
        // limits: the render clock only starts once the status leaves "queued". The render limit is
        // configurable per book via exportTimeoutSeconds in the render unit config, else the server default.
        long renderLimit = renderLimitSeconds(config);
        long queueDeadline = System.nanoTime()
                + Duration.ofSeconds(Math.max(renderLimit * 3, 1800)).toNanos();
        long renderDeadline = System.nanoTime() + Duration.ofSeconds(renderLimit).toNanos();
        boolean started = false;
        while (true) {
            if (!started) {
                if (System.nanoTime() > queueDeadline) {
                    throw new RenderException("docbuilder engine: waited too long in the exporter queue for document '"
                            + docId + "'");
                }
            } else if (System.nanoTime() > renderDeadline) {
                throw new RenderException("docbuilder engine: export timed out after "
                        + renderLimit + "s for document '" + docId + "'");
            }
            Thread.sleep(3000L);
            HttpRequest.Builder pb = HttpRequest.newBuilder(URI.create(statusUrl))
                    .timeout(Duration.ofSeconds(30)).header("Accept", "application/json");
            maybeForwardEdgeToken(pb, config, exportBase, callerToken);
            HttpResponse<String> pres = http.send(pb.GET().build(), HttpResponse.BodyHandlers.ofString());
            if (pres.statusCode() / 100 != 2) {
                throw new RenderException("docbuilder engine: export status returned HTTP "
                        + pres.statusCode() + " for document '" + docId + "'");
            }
            JsonNode st = mapper.readTree(pres.body());
            String status = st.path("status").asText("");
            if (!started && !"queued".equals(status)) {
                // Just picked up: start the render clock here
                started = true;
                renderDeadline = System.nanoTime() + Duration.ofSeconds(renderLimit).toNanos();
                log.info("[docbuilder:{}] exporter picked up job {}, render clock started", reportTag, jobId);
            }
            if ("done".equals(status)) break;
            if ("error".equals(status) || "failed".equals(status)) {
                String detail = st.path("error").asText("");
                throw new RenderException("docbuilder engine: exporter reported '" + status + "' for document '"
                        + docId + "'" + (detail.isBlank() ? "" : " — " + detail));
            }
        }

        String fileUrl = statusUrl + "/file";
        HttpRequest.Builder fb = HttpRequest.newBuilder(URI.create(fileUrl))
                .timeout(Duration.ofSeconds(renderLimit)).header("Accept", "application/pdf");
        maybeForwardEdgeToken(fb, config, exportBase, callerToken);
        HttpResponse<java.nio.file.Path> fres = http.send(fb.GET().build(), HttpResponse.BodyHandlers.ofFile(dest));
        if (fres.statusCode() / 100 != 2) {
            throw new RenderException("docbuilder engine: export file returned HTTP " + fres.statusCode()
                    + " for document '" + docId + "'");
        }
        return java.nio.file.Files.size(dest);
    }

    private String resolveNumericId(String baseUrl, String publicId, JsonNode config,
                                    String callerToken, String reportTag) {
        String url = baseUrl + "/api/documents/" + URLEncoder.encode(publicId, StandardCharsets.UTF_8);
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(30))
                    .header("Accept", "application/json");
            maybeForwardEdgeToken(b, config, baseUrl, callerToken);
            HttpResponse<String> res = http.send(b.GET().build(), HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() / 100 != 2) {
                throw new RenderException("docbuilder engine: could not resolve document '" + publicId
                        + "' — GET " + url + " returned HTTP " + res.statusCode());
            }
            String body = res.body() == null ? "" : res.body().stripLeading();
            // A gateway that wants a login answers 200 with the sign-in PAGE rather than JSON; say so
            // instead of surfacing a Jackson parse error about an unexpected '<'.
            if (!body.startsWith("{")) {
                throw new RenderException("docbuilder engine: document lookup for '" + publicId
                        + "' did not return JSON — the document-builder API is most likely behind a login redirect "
                        + "(check forwardEdgeToken / the service-account token)");
            }
            JsonNode id = mapper.readTree(body).get("id");
            if (id == null || !id.canConvertToLong()) {
                throw new RenderException("docbuilder engine: document '" + publicId
                        + "' has no numeric id in the lookup response");
            }
            log.info("[docbuilder:{}] resolved publicId {} -> document id {}", reportTag, publicId, id.asText());
            return id.asText();
        } catch (RenderException re) {
            throw re;
        } catch (Exception e) {
            throw new RenderException("docbuilder engine: document lookup for '" + publicId
                    + "' failed: " + e.getMessage(), e);
        }
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    private static String trimTrailingSlash(String s) {
        if (s == null) return null;
        String t = s.trim();
        while (t.endsWith("/")) t = t.substring(0, t.length() - 1);
        return t;
    }

    /** Replace $P{name} with URL-encoded run-parameter values. */
    private static String substitute(String tpl, Map<String, Object> params) {
        if (tpl == null) return null;
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
     * Forward the caller's edge (Keycloak) token so the export passes the gateway that fronts the document builder.
     * Sets BOTH the header the oauth2-proxy validates ({@code Authorization: Bearer}) and the one it
     * injects for the app ({@code X-Forwarded-Access-Token}), matching the api engine. The caller's own
     * token is used when present (an edge run, audited as that person); otherwise the configured service
     * account. Restricted to the allow-listed host suffixes so a mistyped baseUrl can never ship a
     * user's token somewhere else. Opt out with {@code forwardEdgeToken=false} for an in-cluster baseUrl.
     */
    private void maybeForwardEdgeToken(HttpRequest.Builder b, JsonNode config, String baseUrl, String callerToken) {
        String opt = text(config, "forwardEdgeToken");
        if ("false".equalsIgnoreCase(opt)) return; // explicit opt-out; default (absent/blank) is ON
        String token = (callerToken != null && !callerToken.isBlank()) ? callerToken : serviceTokens.getToken();
        if (token == null || token.isBlank()) return;
        String host;
        try { host = URI.create(baseUrl).getHost(); } catch (Exception e) { host = null; }
        if (host == null || !hostAllowedForToken(host)) {
            log.warn("docbuilder engine: baseUrl host '{}' is not in the token-forward allow-list {} — "
                    + "NOT forwarding a token", host, tokenForwardHostSuffixes);
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

    /**
     * SSRF guard, same rule as the other remote engines: require http(s) and keep the host fixed —
     * only the docId (path) may come from a run parameter, never the authority.
     */
    private static void guardUrl(String baseUrl, String finalUrl) {
        URI uri;
        try { uri = URI.create(finalUrl); }
        catch (Exception e) { throw new RenderException("docbuilder engine: invalid URL after substitution"); }
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            throw new RenderException("docbuilder engine: baseUrl must use http or https");
        }
        if (baseUrl.contains("$P")) {
            throw new RenderException("docbuilder engine: baseUrl must be fixed — "
                    + "$P{...} is only allowed in docId");
        }
    }
}
