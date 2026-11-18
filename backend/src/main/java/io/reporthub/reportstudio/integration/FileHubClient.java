package io.reporthub.reportstudio.integration;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Minimal FileHub API client (API-key auth: {@code Authorization: Bearer fhk_...}).
 * {@code baseUrl} is the FileHub API root that contains {@code /api}, e.g. {@code http://host:8090/fh}.
 */
public class FileHubClient {

    public record Uploaded(String id, String name, long sizeBytes) {}

    /** Failure talking to FileHub; {@code status} 0 = not reachable. */
    public static class FileHubException extends RuntimeException {
        private final int status;
        public FileHubException(int status, String message) { super(message); this.status = status; }
        public int status() { return status; }
    }

    private final String baseUrl;
    private final String apiKey;
    private final Duration timeout;
    private final HttpClient http;
    private final ObjectMapper json = new ObjectMapper();

    public FileHubClient(String baseUrl, String apiKey, Duration timeout) {
        this.baseUrl = trim(baseUrl);
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.timeout = timeout;
        this.http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(timeout).build();
    }

    public String baseUrl() { return baseUrl; }

    /** {@code GET /api/auth/me} - the account the key belongs to (email, role). */
    public Map<String, Object> me() {
        JsonNode n = send(req("/api/auth/me").GET().build());
        JsonNode u = n.has("user") ? n.get("user") : n;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", text(u, "id"));
        m.put("email", text(u, "email"));
        m.put("role", text(u, "role"));
        return m;
    }

    /**
     * Id of the folder at {@code path} ("a/b/c") in {@code systemId}; each missing level is created
     * under its parent (FileHub folder names cannot contain a slash).
     */
    public String ensureFolder(String systemId, String orgId, String path) {
        String parent = null;
        for (String seg : path.split("/")) {
            String name = seg.trim();
            if (name.isEmpty()) continue;
            parent = ensureChild(systemId, orgId, parent, name);
        }
        return parent;
    }

    private String ensureChild(String systemId, String orgId, String parentId, String name) {
        String q = "/api/folders?system_id=" + enc(systemId) + "&parent_id=" + (parentId == null ? "null" : enc(parentId));
        JsonNode list = send(req(q).GET().build());
        if (list.isArray()) {
            for (JsonNode f : list) {
                String p = text(f, "parent_id");
                boolean sameParent = parentId == null ? p.isEmpty() : parentId.equals(p) || !f.has("parent_id");
                if (name.equals(text(f, "name")) && sameParent) return text(f, "id");
            }
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("system_id", systemId);
        if (orgId != null && !orgId.isBlank()) body.put("org_id", orgId);
        if (parentId != null) body.put("parent_id", parentId);
        try {
            JsonNode created = send(req("/api/folders").header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build());
            return text(created, "id");
        } catch (FileHubException e) {
            throw e;
        } catch (Exception e) {
            throw new FileHubException(0, e.getMessage());
        }
    }

    /** {@code POST /api/files} (multipart). Optional fields are skipped when blank. */
    public Uploaded upload(byte[] bytes, String filename, String contentType, Map<String, String> fields) {
        String boundary = "----rh" + UUID.randomUUID().toString().replace("-", "");
        ByteArrayOutputStream out = new ByteArrayOutputStream(bytes.length + 1024);
        fields.forEach((k, v) -> {
            if (v == null || v.isBlank()) return;
            write(out, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + k + "\"\r\n\r\n" + v + "\r\n");
        });
        write(out, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\""
                + filename.replace("\"", "_") + "\"; filename*=UTF-8''" + enc(filename) + "\r\nContent-Type: "
                + (contentType == null ? "application/octet-stream" : contentType) + "\r\n\r\n");
        out.writeBytes(bytes);
        write(out, "\r\n--" + boundary + "--\r\n");
        JsonNode n = send(req("/api/files").header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(out.toByteArray())).build());
        JsonNode f = n.isArray() && n.size() > 0 ? n.get(0) : n;
        String id = text(f, "id");
        if (id.isEmpty()) throw new FileHubException(502, "FileHub did not return a file id");
        return new Uploaded(id, text(f, "name"), f.path("size_bytes").asLong(bytes.length));
    }

    /** Link stored on the published output: {@code linkTemplate} with {id}, or the API download path. */
    public static String link(String baseUrl, String linkTemplate, String fileId) {
        if (linkTemplate != null && !linkTemplate.isBlank()) return linkTemplate.trim().replace("{id}", fileId);
        return trim(baseUrl) + "/api/files/" + fileId + "/download";
    }

    private HttpRequest.Builder req(String path) {
        if (!baseUrl.matches("(?i)https?://.+")) throw new FileHubException(0, "FileHub base URL must start with http:// or https://");
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl + path)).timeout(timeout)
                .header("Accept", "application/json");
        if (!apiKey.isEmpty()) b.header("Authorization", "Bearer " + apiKey);
        return b;
    }

    private JsonNode send(HttpRequest r) {
        HttpResponse<String> res;
        try {
            res = http.send(r, HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new FileHubException(0, "interrupted");
        } catch (Exception e) {
            throw new FileHubException(0, "FileHub is not reachable: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
        }
        String body = res.body() == null ? "" : res.body();
        if (res.statusCode() / 100 != 2) throw new FileHubException(res.statusCode(), message(res.statusCode(), body));
        try {
            return body.isBlank() ? json.createObjectNode() : json.readTree(body);
        } catch (Exception e) {
            throw new FileHubException(502, "FileHub returned a non-JSON answer");
        }
    }

    static String message(int status, String body) {
        String detail = "";
        String b = body == null ? "" : body.trim();
        if (b.startsWith("{")) {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"(?:error|message)\"\\s*:\\s*\"([^\"]{1,160})\"").matcher(b);
            if (m.find()) detail = ": " + m.group(1);
        }
        return switch (status) {
            case 401 -> "FileHub rejected the API key (HTTP 401)" + detail;
            case 403 -> "The FileHub account of this key may not do this (HTTP 403)" + detail;
            default -> "FileHub answered HTTP " + status + detail;
        };
    }

    private static String text(JsonNode n, String f) {
        JsonNode v = n == null ? null : n.get(f);
        return v == null || v.isNull() ? "" : v.asText();
    }

    private static void write(ByteArrayOutputStream o, String s) { o.writeBytes(s.getBytes(StandardCharsets.UTF_8)); }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20"); }

    static String trim(String s) {
        if (s == null) return "";
        String t = s.trim();
        while (t.endsWith("/")) t = t.substring(0, t.length() - 1);
        return t;
    }
}
