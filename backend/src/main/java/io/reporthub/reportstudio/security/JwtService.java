package io.reporthub.reportstudio.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jws;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;

/**
 * Issues and validates HS256 JWTs (jjwt 0.12.x API).
 *
 * <p>Subject = username, with a {@code role} claim. Secret and TTL come from
 * {@code app.jwt.secret} / {@code app.jwt.ttlMinutes}.
 */
@Service
public class JwtService {

    private final SecretKey key;
    private final long ttlMinutes;

    public JwtService(@Value("${app.jwt.secret}") String secret,
                      @Value("${app.jwt.ttlMinutes:120}") long ttlMinutes) {
        // HS256 requires a key of at least 256 bits (32 bytes); enforced by Keys.hmacShaKeyFor.
        this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.ttlMinutes = ttlMinutes;
    }

    /** Mint a signed token for the given username + role. */
    public String generate(String username, String role) {
        return generate(username, role, null);
    }

    /** Mint a token that also carries the user's tenant. */
    public String generate(String username, String role, String tenant) {
        Instant now = Instant.now();
        Instant exp = now.plusSeconds(ttlMinutes * 60);
        return Jwts.builder()
                .subject(username)
                .claim("role", role)
                .claim("tenant", tenant == null ? "default" : tenant)
                .claim("iatms", now.toEpochMilli())   // JWT iat is whole seconds; revocation compares millis
                .issuedAt(Date.from(now))
                .expiration(Date.from(exp))
                .signWith(key)
                .compact();
    }

    /** Parse + verify a token, returning its claims. Throws {@link JwtException} if invalid/expired/revoked. */
    public Claims parse(String token) {
        Jws<Claims> jws = Jwts.parser()
                .verifyWith(key)
                .build()
                .parseSignedClaims(token);
        Claims c = jws.getPayload();
        if (revoked.containsKey(token)) throw new io.jsonwebtoken.JwtException("Token was signed out");
        Instant cutoff = c.getSubject() == null ? null : revokedBefore.get(c.getSubject());
        if (cutoff != null && issuedAt(c) != null && !issuedAt(c).isAfter(cutoff)) {
            throw new io.jsonwebtoken.JwtException("Token was invalidated (password changed)");
        }
        return c;
    }

    /**
     * Sign-out list: tokens revoked before their expiry (kept until they would have expired anyway).
     * In-memory, per instance - with several API replicas a signed-out token stays valid on the others
     * until it expires.
     */
    private final java.util.Map<String, Instant> revoked = new java.util.concurrent.ConcurrentHashMap<>();
    /** Per user: tokens issued before this instant are rejected (password change / reset). */
    private final java.util.Map<String, Instant> revokedBefore = new java.util.concurrent.ConcurrentHashMap<>();

    /** Issue instant with millisecond precision ({@code iatms}), falling back to the second-precision iat. */
    static Instant issuedAt(Claims c) {
        Object ms = c.get("iatms");
        if (ms instanceof Number n) return Instant.ofEpochMilli(n.longValue());
        // legacy token: whole seconds - treat as issued at the very end of that second's predecessor
        return c.getIssuedAt() == null ? null : c.getIssuedAt().toInstant().minusMillis(1);
    }

    /** Revoke one token (logout). Invalid tokens are ignored. */
    public void revoke(String token) {
        try {
            Claims c = Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();
            revoked.put(token, c.getExpiration() == null ? Instant.now().plusSeconds(ttlMinutes * 60) : c.getExpiration().toInstant());
        } catch (Exception ignored) {
            return;
        }
        Instant now = Instant.now();
        revoked.values().removeIf(exp -> exp.isBefore(now));
    }

    /** Invalidate every token issued to {@code username} so far (password change/reset). */
    public void revokeAllFor(String username) {
        revokedBefore.put(username, Instant.now());
        // a token minted in the same millisecond as the reset must still be rejected; wait one tick
        try { Thread.sleep(1); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    /**
     * Sign-out list for IAM tokens (not ours to verify): keyed by SHA-256 of the token, kept until
     * {@code until} (the token's exp when it is a readable JWT, else now + TTL).
     */
    private final java.util.Map<String, Instant> revokedForeign = new java.util.concurrent.ConcurrentHashMap<>();

    public void revokeForeign(String token) {
        if (token == null || token.isBlank()) return;
        Instant until = foreignExpiry(token);
        revokedForeign.put(sha256(token), until);
        Instant now = Instant.now();
        revokedForeign.values().removeIf(exp -> exp.isBefore(now));
    }

    public boolean isForeignRevoked(String token) {
        if (token == null) return false;
        Instant exp = revokedForeign.get(sha256(token));
        return exp != null && exp.isAfter(Instant.now());
    }

    private Instant foreignExpiry(String token) {
        try {
            String[] parts = token.split("\\.");
            if (parts.length >= 2) {
                String json = new String(java.util.Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"exp\"\\s*:\\s*(\\d+)").matcher(json);
                if (m.find()) return Instant.ofEpochSecond(Long.parseLong(m.group(1)));
            }
        } catch (Exception ignored) { /* opaque token */ }
        return Instant.now().plusSeconds(Math.max(ttlMinutes, 1440) * 60);
    }

    static String sha256(String token) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) { throw new IllegalStateException(e); }
    }

    /** Username (subject) carried by the token. */
    public String username(String token) {
        return parse(token).getSubject();
    }

    /** Role claim carried by the token (e.g. {@code ADMIN} / {@code USER}). */
    public String role(String token) {
        return parse(token).get("role", String.class);
    }

    /** Configured token lifetime, in minutes. */
    public long getTtlMinutes() {
        return ttlMinutes;
    }
}
