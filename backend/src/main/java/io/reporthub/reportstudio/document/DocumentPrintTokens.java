package io.reporthub.reportstudio.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.reporthub.reportstudio.iam.CurrentPrincipal;
import io.reporthub.reportstudio.iam.RhPrincipal;
import io.reporthub.reportstudio.tenancy.TenantContext;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;

/**
 * Short-lived signed tokens for the document print page.
 *
 * <p>The exporter's headless browser is not signed in, so the backend hands it a token that binds
 * one document id to the tenant + project and the principal of the user who asked for the PDF
 * (HMAC-SHA256 with {@code app.documents.print-key}). The public print endpoint loads the
 * document inside that scope and resolves its data as that principal, so a token cannot read a
 * document of another tenant/project and row filters apply exactly as on screen.
 */
@Component
public class DocumentPrintTokens {

    /** Token body: document id, tenant, project, principal (null = system), expiry (epoch seconds). */
    public record Claims(long d, String t, String p, RhPrincipal u, long e) {
        public TenantContext.Scope scope() { return TenantContext.of(t, p); }
    }

    private static final Base64.Encoder ENC = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder DEC = Base64.getUrlDecoder();

    private final ObjectMapper json;
    private final byte[] secret;
    private final long ttlSeconds;

    public DocumentPrintTokens(ObjectMapper json,
                               @Value("${app.documents.print-key:change-me-print-key}") String printKey,
                               @Value("${app.documents.print-token-ttl-seconds:1800}") long ttlSeconds) {
        this.json = json;
        this.secret = printKey.getBytes(StandardCharsets.UTF_8);
        this.ttlSeconds = ttlSeconds;
    }

    /** Token for {@code documentId} in the caller's current scope, as the current principal. */
    public String mint(long documentId) {
        TenantContext.Scope s = TenantContext.current()
                .orElse(TenantContext.of(TenantContext.DEFAULT_TENANT, TenantContext.DEFAULT_PROJECT));
        RhPrincipal who = CurrentPrincipal.get().orElse(null);
        return mint(new Claims(documentId, s.tenantId(), s.projectId(), who, Instant.now().getEpochSecond() + ttlSeconds));
    }

    String mint(Claims c) {
        try {
            String body = ENC.encodeToString(json.writeValueAsBytes(c));
            return body + "." + ENC.encodeToString(sign(body));
        } catch (Exception e) {
            throw new IllegalStateException("Cannot sign print token", e);
        }
    }

    /** Verified claims for {@code documentId}; throws {@link SecurityException} when invalid, expired or for another id. */
    public Claims verify(String token, long documentId) {
        if (token == null || token.isBlank()) throw new SecurityException("Print token required");
        int dot = token.indexOf('.');
        if (dot <= 0) throw new SecurityException("Malformed print token");
        String body = token.substring(0, dot);
        byte[] sig;
        try {
            sig = DEC.decode(token.substring(dot + 1));
        } catch (IllegalArgumentException e) {
            throw new SecurityException("Malformed print token");
        }
        if (!MessageDigest.isEqual(sign(body), sig)) throw new SecurityException("Invalid print token");
        Claims c;
        try {
            c = json.readValue(DEC.decode(body), Claims.class);
        } catch (Exception e) {
            throw new SecurityException("Malformed print token");
        }
        if (c.e() < Instant.now().getEpochSecond()) throw new SecurityException("Print token expired");
        if (c.d() != documentId) throw new SecurityException("Print token is for another document");
        return c;
    }

    private byte[] sign(String body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return mac.doFinal(body.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
