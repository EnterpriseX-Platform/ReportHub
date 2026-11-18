package io.reporthub.reportstudio.iam;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** IamClient against a fake IAM service (JDK HTTP server) answering in IAM's response shapes. */
class IamClientTest {

    HttpServer server;
    IamClient client;
    final List<String> calls = new CopyOnWriteArrayList<>();
    final List<String> auths = new CopyOnWriteArrayList<>();

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/auth/login", ex -> {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (body.contains("\"password\":\"secret\"")) {
                reply(ex, 200, "{\"success\":true,\"data\":{\"token\":\"tok-1\",\"user\":{\"id\":\"u1\"}}}");
            } else {
                reply(ex, 401, "{\"success\":false,\"error\":\"Invalid username or password\"}");
            }
        });
        server.createContext("/api/auth/me", ex -> {
            if (!"Bearer tok-1".equals(ex.getRequestHeaders().getFirst("Authorization"))) {
                reply(ex, 401, "{\"success\":false,\"error\":\"Invalid or expired token\"}");
                return;
            }
            reply(ex, 200, "{\"success\":true,\"data\":{\"id\":\"u1\",\"username\":\"ann\",\"email\":\"ann@example.org\","
                    + "\"fullName\":\"Ann Analyst\",\"tenantId\":\"t-uuid\",\"isAdmin\":false}}");
        });
        server.createContext("/api/users/u1", ex -> reply(ex, 200,
                "{\"success\":true,\"data\":{\"id\":\"u1\",\"departmentCode\":\"D01\",\"positionCode\":\"P7\","
                        + "\"employeeCode\":\"E123\",\"tenant\":{\"id\":\"t-uuid\",\"code\":\"ACME\",\"name\":\"Acme\"}}}"));
        server.createContext("/api/perms/by-user", ex -> reply(ex, 200,
                "{\"success\":true,\"data\":{\"roles\":[{\"code\":\"ANALYST\"}],\"responsibilities\":[{\"code\":\"FIN\"}],"
                        + "\"permissions\":["
                        + "{\"object\":{\"code\":\"RH.REPORT\"},\"permissions\":{\"canView\":true,\"canCreate\":false,\"canEdit\":false,"
                        + "\"canDelete\":false,\"canApprove\":false,\"canExport\":true}},"
                        + "{\"object\":{\"code\":\"RH.DATASET\"},\"permissions\":{\"canView\":true}}]}}"));
        server.createContext("/api/perms/check", ex -> reply(ex, 200,
                "{\"success\":true,\"data\":{\"allowed\":" + ex.getRequestURI().getQuery().contains("canView") + "}}"));
        server.createContext("/api/health", ex -> reply(ex, 200, "{\"status\":\"ok\"}"));
        server.start();
        String base = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        client = new IamClient(() -> IamSettings.trimSlash(base), new ObjectMapper(), Duration.ofSeconds(2));
    }

    @AfterEach
    void stop() { server.stop(0); }

    private void reply(HttpExchange ex, int status, String body) throws IOException {
        calls.add(ex.getRequestMethod() + " " + ex.getRequestURI().getPath());
        String a = ex.getRequestHeaders().getFirst("Authorization");
        if (a != null) auths.add(a);
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, b.length);
        ex.getResponseBody().write(b);
        ex.close();
    }

    @Test
    void loginCollectsIdentityAttributesAndObjectPermissions() {
        IamClient.Login l = client.login("ann", "secret");
        assertThat(l.token()).isEqualTo("tok-1");
        var u = l.user();
        assertThat(u.username()).isEqualTo("ann");
        assertThat(u.displayName()).isEqualTo("Ann Analyst");
        assertThat(u.iamTenantId()).isEqualTo("t-uuid");
        assertThat(u.tenantCode()).isEqualTo("ACME");
        assertThat(u.roles()).containsExactly("ANALYST");
        assertThat(u.responsibilities()).containsExactly("FIN");
        assertThat(u.attributes()).containsEntry("departmentCode", "D01").containsEntry("positionCode", "P7")
                .containsEntry("employeeCode", "E123");
        assertThat(u.objectPerms().get("RH.REPORT")).containsExactlyInAnyOrder("view", "execute");
        assertThat(u.objectPerms().get("RH.DATASET")).containsExactly("view");
        assertThat(calls).contains("POST /api/auth/login", "GET /api/auth/me", "GET /api/perms/by-user", "GET /api/users/u1");
        assertThat(auths).allMatch("Bearer tok-1"::equals);
    }

    @Test
    void wrongPasswordSurfacesIamsStatusAndMessage() {
        assertThatThrownBy(() -> client.login("ann", "nope"))
                .isInstanceOf(IamException.class)
                .hasMessageContaining("Invalid username or password")
                .extracting(e -> ((IamException) e).status()).isEqualTo(401);
    }

    @Test
    void invalidTokenIsRejected() {
        assertThatThrownBy(() -> client.load("forged")).isInstanceOf(IamException.class)
                .extracting(e -> ((IamException) e).status()).isEqualTo(401);
    }

    @Test
    void singleObjectCheckMapsActionsToIamFlags() {
        assertThat(client.check("tok-1", "RH.REPORT", "view")).isTrue();
        assertThat(client.check("tok-1", "RH.REPORT", "delete")).isFalse();
    }

    @Test
    void unreachableOrUnconfiguredServiceIsAnIamException() {
        IamClient none = new IamClient(() -> "", new ObjectMapper(), Duration.ofSeconds(1));
        assertThatThrownBy(() -> none.load("x")).isInstanceOf(IamException.class).hasMessageContaining("not configured");
        IamClient down = new IamClient(() -> "http://127.0.0.1:1", new ObjectMapper(), Duration.ofSeconds(1));
        assertThatThrownBy(() -> down.load("x")).isInstanceOf(IamException.class).hasMessageContaining("unavailable")
                .hasMessageNotContaining("127.0.0.1");   // never leaks the internal IAM address
    }

    @Test
    void healthReportsReachability() {
        Map<String, Object> h = client.health();
        assertThat(h).containsEntry("ok", true).containsEntry("status", 200);
    }
}
