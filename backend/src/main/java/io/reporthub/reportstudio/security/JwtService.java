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
        Instant now = Instant.now();
        Instant exp = now.plusSeconds(ttlMinutes * 60);
        return Jwts.builder()
                .subject(username)
                .claim("role", role)
                .issuedAt(Date.from(now))
                .expiration(Date.from(exp))
                .signWith(key)
                .compact();
    }

    /** Parse + verify a token, returning its claims. Throws {@link JwtException} if invalid/expired. */
    public Claims parse(String token) {
        Jws<Claims> jws = Jwts.parser()
                .verifyWith(key)
                .build()
                .parseSignedClaims(token);
        return jws.getPayload();
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
