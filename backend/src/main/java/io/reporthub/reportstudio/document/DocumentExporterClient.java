package io.reporthub.reportstudio.document;

import io.reporthub.reportstudio.web.BadRequestException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;

/** Calls the bundled document exporter (engines/document-exporter) to turn a document's print page into a PDF. */
@Component
public class DocumentExporterClient {

    private final String exporterUrl;
    private final long timeoutSeconds;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    public DocumentExporterClient(@Value("${app.documents.exporter-url:http://localhost:3200}") String exporterUrl,
                                  @Value("${app.documents.exporter-timeout-seconds:${APP_DOCUMENT_EXPORTER_TIMEOUT_SECONDS:60}}") long timeoutSeconds) {
        this.exporterUrl = exporterUrl.replaceAll("/+$", "");
        this.timeoutSeconds = timeoutSeconds;
    }

    public String exporterUrl() {
        return exporterUrl;
    }

    /** {@code printToken} (see {@link DocumentPrintTokens}) is passed through to the print page as {@code t}. */
    public byte[] pdf(long documentId, Map<String, ?> params, String printToken) {
        StringBuilder url = new StringBuilder(exporterUrl).append("/api/export/pdf/").append(documentId)
                .append("?t=").append(URLEncoder.encode(printToken, StandardCharsets.UTF_8));
        char sep = '&';
        if (params != null) {
            for (Map.Entry<String, ?> e : params.entrySet()) {
                url.append(sep).append(URLEncoder.encode("p." + e.getKey(), StandardCharsets.UTF_8)).append('=')
                        .append(URLEncoder.encode(e.getValue() == null ? "" : String.valueOf(e.getValue()), StandardCharsets.UTF_8));
                sep = '&';
            }
        }
        try {
            HttpResponse<byte[]> res = http.send(HttpRequest.newBuilder(URI.create(url.toString()))
                    .timeout(Duration.ofSeconds(timeoutSeconds)).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
            if (res.statusCode() / 100 != 2) {
                String detail = shortDetail(new String(res.body(), StandardCharsets.UTF_8));
                org.slf4j.LoggerFactory.getLogger(DocumentExporterClient.class)
                        .warn("Document exporter HTTP {} for document {}: {}", res.statusCode(), documentId, detail);
                if (res.statusCode() >= 500) {
                    throw new org.springframework.web.server.ResponseStatusException(
                            org.springframework.http.HttpStatus.BAD_GATEWAY,
                            "Document export failed" + (detail.isEmpty() ? "" : ": " + detail));
                }
                throw new BadRequestException("Document export rejected" + (detail.isEmpty() ? "" : ": " + detail));
            }
            return res.body();
        } catch (BadRequestException | org.springframework.web.server.ResponseStatusException e) {
            throw e;
        } catch (java.net.http.HttpTimeoutException e) {
            org.slf4j.LoggerFactory.getLogger(DocumentExporterClient.class)
                    .warn("Document exporter timed out after {}s for document {}", timeoutSeconds, documentId);
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.GATEWAY_TIMEOUT,
                    "Document exporter did not answer within " + timeoutSeconds + " seconds");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BadRequestException("Document export interrupted");
        } catch (Exception e) {
            org.slf4j.LoggerFactory.getLogger(DocumentExporterClient.class)
                    .warn("Document exporter call failed for document {}: {}", documentId, e.toString());
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE, "Document exporter is unavailable; please retry");
        }
    }

    /** First line of an exporter error, without stack frames or URLs, at most 200 chars. */
    static String shortDetail(String body) {
        if (body == null) return "";
        String b = body.trim();
        if (b.startsWith("<")) return "";
        String first = b.split("\\R", 2)[0].replaceAll("https?://\\S+", "").replaceAll("\\s+at\\s.*$", "").trim();
        return first.length() > 200 ? first.substring(0, 200) : first;
    }
}
