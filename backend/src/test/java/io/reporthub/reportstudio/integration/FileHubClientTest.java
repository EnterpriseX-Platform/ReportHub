package io.reporthub.reportstudio.integration;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class FileHubClientTest {

    private HttpServer server;
    private String base;
    private final List<String> auth = new CopyOnWriteArrayList<>();
    private volatile String lastBody = "";
    private final List<String> folderQueries = new CopyOnWriteArrayList<>();
    private final List<String> created = new CopyOnWriteArrayList<>();

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/fh/api/auth/me", ex -> {
            auth.add(ex.getRequestHeaders().getFirst("Authorization"));
            boolean ok = "Bearer fhk_good".equals(ex.getRequestHeaders().getFirst("Authorization"));
            reply(ex, ok ? 200 : 401, ok ? "{\"user\":{\"id\":\"usr_1\",\"email\":\"svc@example.org\",\"role\":\"editor\"}}" : "{\"error\":\"invalid key\"}");
        });
        server.createContext("/fh/api/folders", ex -> {
            String q = ex.getRequestURI().getQuery();
            if ("GET".equals(ex.getRequestMethod())) {
                folderQueries.add(q);
                reply(ex, 200, q.contains("parent_id=null") ? "[{\"id\":\"fld_rpt\",\"name\":\"RPT\",\"parent_id\":null}]" : "[]");
            } else {
                String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                created.add(body);
                reply(ex, 200, "{\"id\":\"fld_" + created.size() + "\"}");
            }
        });
        server.createContext("/fh/api/files", ex -> {
            lastBody = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            reply(ex, 200, "{\"id\":\"f-123\",\"name\":\"a.pdf\",\"size_bytes\":3}");
        });
        server.start();
        base = "http://127.0.0.1:" + server.getAddress().getPort() + "/fh/";
    }

    @AfterEach
    void stop() { server.stop(0); }

    private static void reply(com.sun.net.httpserver.HttpExchange ex, int status, String body) throws java.io.IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, b.length);
        ex.getResponseBody().write(b);
        ex.close();
    }

    @Test
    void meSendsBearerKey() {
        Map<String, Object> me = new FileHubClient(base, "fhk_good", Duration.ofSeconds(2)).me();
        assertThat(me).containsEntry("email", "svc@example.org").containsEntry("role", "editor");
        assertThat(auth).containsExactly("Bearer fhk_good");
    }

    @Test
    void badKeyIs401WithMessage() {
        assertThatThrownBy(() -> new FileHubClient(base, "fhk_bad", Duration.ofSeconds(2)).me())
                .isInstanceOf(FileHubClient.FileHubException.class)
                .hasMessageContaining("401").hasMessageContaining("invalid key");
    }

    @Test
    void uploadIsMultipartWithFields() {
        FileHubClient c = new FileHubClient(base, "fhk_good", Duration.ofSeconds(2));
        FileHubClient.Uploaded u = c.upload("abc".getBytes(), "a.pdf", "application/pdf",
                new java.util.LinkedHashMap<>(Map.of("system_id", "sys_x", "org_id", "")));
        assertThat(u.id()).isEqualTo("f-123");
        assertThat(lastBody).contains("name=\"system_id\"").contains("sys_x").contains("filename=\"a.pdf\"")
                .contains("abc").doesNotContain("name=\"org_id\"");
    }

    @Test
    void ensureFolderWalksPathReusingAndCreatingLevels() {
        FileHubClient c = new FileHubClient(base, "fhk_good", Duration.ofSeconds(2));
        // RPT exists at the root; 2026 and 03 are created under their parents
        assertThat(c.ensureFolder("sys_x", null, "RPT/2026/03")).isEqualTo("fld_2");
        assertThat(created).hasSize(2);
        assertThat(created.get(0)).contains("\"name\":\"2026\"").contains("\"parent_id\":\"fld_rpt\"");
        assertThat(created.get(1)).contains("\"name\":\"03\"").contains("\"parent_id\":\"fld_1\"");
        assertThat(folderQueries.get(0)).contains("system_id=sys_x").contains("parent_id=null");
    }

    @Test
    void unreachableAndLink() {
        assertThatThrownBy(() -> new FileHubClient("http://127.0.0.1:1/fh", "k", Duration.ofSeconds(1)).me())
                .isInstanceOf(FileHubClient.FileHubException.class).hasMessageContaining("not reachable");
        assertThat(FileHubClient.link("http://h/fh/", null, "f1")).isEqualTo("http://h/fh/api/files/f1/download");
        assertThat(FileHubClient.link("http://h/fh", "http://ui/files/{id}", "f1")).isEqualTo("http://ui/files/f1");
    }
}
