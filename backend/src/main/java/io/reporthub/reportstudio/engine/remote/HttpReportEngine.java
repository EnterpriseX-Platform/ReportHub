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
import java.util.Map;

/**
 * Generic remote HTTP engine (kind {@code http}). POSTs a simple
 * {@code {code, format, params}} envelope to the configured {@code baseUrl} and treats the response
 * body as the rendered document. For the OneWeb-specific contract use the {@code component} engine.
 */
@Component
public class HttpReportEngine implements ReportEngine {

    public static final String KIND = "http";

    private final ObjectMapper mapper;
    /** Max response size in bytes, rejected AFTER streaming to disk; 0 = no cap. Set via app.engine.remote.max-bytes. */
    private final long maxBytes;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();

    public HttpReportEngine(ObjectMapper kafkaObjectMapper,
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
        return true; // remote: needs a configured baseUrl
    }

    @Override
    public String label() {
        return "HTTP renderer";
    }

    @Override
    public java.util.List<io.reporthub.reportstudio.engine.EngineProp> instanceProps() {
        return java.util.List.of(
                io.reporthub.reportstudio.engine.EngineProp.instanceColumn("baseUrl", "Base URL", "url", true, "https://renderer.example/api"),
                io.reporthub.reportstudio.engine.EngineProp.instanceColumn("authToken", "Bearer token", "password", false, ""));
    }

    @Override
    public RenderResult render(RenderRequest req, EngineConfig cfg) {
        if (cfg == null || cfg.baseUrl() == null || cfg.baseUrl().isBlank()) {
            throw new RenderException("HTTP engine has no baseUrl configured");
        }
        String fmt = (req.format() == null ? "pdf" : req.format()).toLowerCase();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", req.code());
        body.put("format", fmt);
        body.put("params", req.params() == null ? Map.of() : req.params());
        java.nio.file.Path tmp = null;
        try {
            String json = mapper.writeValueAsString(body);
            HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(cfg.baseUrl()))
                    .timeout(Duration.ofSeconds(120))
                    .header("Content-Type", "application/json")
                    .header("Accept", "*/*")
                    .POST(HttpRequest.BodyPublishers.ofString(json));
            if (cfg.authToken() != null && !cfg.authToken().isBlank()) {
                rb.header("Authorization", "Bearer " + cfg.authToken());
            }
            // Stream the response document to a temp file rather than buffering it in the heap, so a
            // large export lands in MinIO instead of OOM-killing the pod. RenderWorker streams the file
            // to storage and deletes it afterwards (ownership passes via RenderResult.ofFile).
            tmp = java.nio.file.Files.createTempFile("rs-http-", ".bin");
            HttpResponse<java.nio.file.Path> res =
                    http.send(rb.build(), HttpResponse.BodyHandlers.ofFile(tmp));
            if (res.statusCode() / 100 != 2) {
                throw new RenderException("HTTP engine returned HTTP " + res.statusCode());
            }
            long size = java.nio.file.Files.size(tmp);
            if (maxBytes > 0 && size > maxBytes) {
                throw new RenderException("HTTP engine response (" + size
                        + " bytes) exceeds the configured limit of " + maxBytes + " bytes");
            }
            String contentType = res.headers().firstValue("Content-Type").orElse("application/pdf");
            RenderResult result = RenderResult.ofFile(tmp, contentType, fmt, size);
            tmp = null; // ownership handed to RenderWorker
            return result;
        } catch (RenderException re) {
            throw re;
        } catch (Exception e) {
            throw new RenderException("HTTP engine call failed: " + e.getMessage(), e);
        } finally {
            if (tmp != null) { try { java.nio.file.Files.deleteIfExists(tmp); } catch (Exception ignore) { } }
        }
    }
}
