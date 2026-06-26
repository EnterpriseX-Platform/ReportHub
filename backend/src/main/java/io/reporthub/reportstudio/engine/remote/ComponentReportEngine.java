package io.reporthub.reportstudio.engine.remote;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.engine.EngineConfig;
import io.reporthub.reportstudio.engine.ReportEngine;
import io.reporthub.reportstudio.render.RenderException;
import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Remote adapter for the existing OneWeb <b>component</b> engine.
 *
 * <p>Forwards to {@code POST {baseUrl}/component/v1/api/export/data} with the documented body
 * {@code {app, component:"yml", elements:[{id, parameters}]}} and a Bearer token taken from
 * {@link EngineConfig} (never hard-coded). The report code is the component {@code id}; the output
 * format is passed as {@code REPORT_TYPE}. Keeps the heavy Aspose/LibreOffice rendering OUT of this
 * process — it happens in the component service.
 */
@Component
public class ComponentReportEngine implements ReportEngine {

    public static final String KIND = "component";

    private final ObjectMapper mapper;
    /** Max response size in bytes, rejected AFTER streaming to disk; 0 = no cap. Set via app.engine.remote.max-bytes. */
    private final long maxBytes;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();

    public ComponentReportEngine(ObjectMapper kafkaObjectMapper,
                                 @Value("${app.engine.remote.max-bytes:0}") long maxBytes) {
        this.mapper = kafkaObjectMapper;
        this.maxBytes = maxBytes;
    }

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public boolean requiresInstance() {
        return true; // remote: needs a configured baseUrl + bearer token
    }

    @Override
    public String label() {
        return "OneWeb Component";
    }

    @Override
    public java.util.List<io.reporthub.reportstudio.engine.EngineProp> instanceProps() {
        return java.util.List.of(
                io.reporthub.reportstudio.engine.EngineProp.instanceColumn("baseUrl", "Base URL", "url", true, "https://oneweb.example"),
                io.reporthub.reportstudio.engine.EngineProp.instanceColumn("authToken", "Bearer token", "password", false, "dckr_pat_… / JWT"),
                io.reporthub.reportstudio.engine.EngineProp.instanceColumn("componentFormat", "Component format", "text", false, "yml"),
                io.reporthub.reportstudio.engine.EngineProp.instanceProp("app", "App id", "text", false, "the OneWeb app id"));
    }

    @Override
    public RenderResult render(RenderRequest req, EngineConfig cfg) {
        if (cfg == null || cfg.baseUrl() == null || cfg.baseUrl().isBlank()) {
            throw new RenderException("Component engine has no baseUrl configured — install/configure it first");
        }
        String fmt = (req.format() == null ? "pdf" : req.format()).toLowerCase();
        String reportType = fmt.toUpperCase();

        Map<String, Object> params = new LinkedHashMap<>();
        if (req.params() != null) params.putAll(req.params());
        params.putIfAbsent("REPORT_TYPE", reportType);

        Map<String, Object> element = Map.of("id", req.code(), "parameters", params);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("app", cfg.props() != null ? cfg.props().getOrDefault("app", "") : "");
        body.put("component", cfg.componentFormat() == null ? "yml" : cfg.componentFormat());
        body.put("elements", List.of(element));

        java.nio.file.Path tmp = null;
        try {
            String json = mapper.writeValueAsString(body);
            String url = cfg.baseUrl().replaceAll("/+$", "") + "/component/v1/api/export/data";
            HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(120))
                    .header("Content-Type", "application/json")
                    .header("Accept", "*/*")
                    .POST(HttpRequest.BodyPublishers.ofString(json));
            if (cfg.authToken() != null && !cfg.authToken().isBlank()) {
                rb.header("Authorization", "Bearer " + cfg.authToken());
            }
            // Stream the rendered document straight to a temp file instead of buffering it in the heap,
            // so a large export lands in MinIO instead of OOM-killing the pod. RenderWorker streams the
            // file to storage and deletes it afterwards (ownership passes via RenderResult.ofFile).
            tmp = java.nio.file.Files.createTempFile("rs-component-", ".bin");
            HttpResponse<java.nio.file.Path> res =
                    http.send(rb.build(), HttpResponse.BodyHandlers.ofFile(tmp));
            if (res.statusCode() / 100 != 2) {
                throw new RenderException("Component engine returned HTTP " + res.statusCode());
            }
            long size = java.nio.file.Files.size(tmp);
            if (maxBytes > 0 && size > maxBytes) {
                throw new RenderException("Component engine response (" + size
                        + " bytes) exceeds the configured limit of " + maxBytes + " bytes");
            }
            String contentType = res.headers().firstValue("Content-Type").orElse(contentTypeFor(fmt));
            RenderResult result = RenderResult.ofFile(tmp, contentType, fmt, size);
            tmp = null; // ownership handed to RenderWorker
            return result;
        } catch (RenderException re) {
            throw re;
        } catch (Exception e) {
            throw new RenderException("Component engine call failed: " + e.getMessage(), e);
        } finally {
            if (tmp != null) { try { java.nio.file.Files.deleteIfExists(tmp); } catch (Exception ignore) { } }
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
