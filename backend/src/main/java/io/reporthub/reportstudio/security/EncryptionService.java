package io.reporthub.reportstudio.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;

/**
 * AES-GCM encryption for secrets at rest (currently the remote-engine {@code authToken}).
 *
 * <p>The 256-bit key is derived (SHA-256) from {@code app.encryption.key}. Each value gets a fresh
 * random 12-byte IV which is prepended to the ciphertext; the whole thing is Base64-encoded and
 * tagged with a {@link #PREFIX} version marker. Anything WITHOUT the marker is treated as legacy
 * plaintext and returned unchanged on decrypt — so existing rows keep working and migrate lazily.
 */
@Component
public class EncryptionService {

    private static final Logger log = LoggerFactory.getLogger(EncryptionService.class);
    private static final String PREFIX = "enc:v1:";
    private static final int IV_LEN = 12;
    private static final int TAG_BITS = 128;
    private static final String DEV_DEFAULT = "change-me-report-studio-dev-encryption-key";

    private final SecretKeySpec key;
    private final SecureRandom random = new SecureRandom();

    public EncryptionService(@Value("${app.encryption.key:}") String secret) {
        String s = (secret == null || secret.isBlank()) ? DEV_DEFAULT : secret;
        if (DEV_DEFAULT.equals(s)) {
            log.warn("app.encryption.key is unset — using the built-in DEV key. Set ENCRYPTION_KEY in prod.");
        }
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            this.key = new SecretKeySpec(hash, "AES");
        } catch (Exception e) {
            throw new IllegalStateException("Cannot initialise encryption key", e);
        }
    }

    /** True if {@code value} is already an encrypted, versioned ciphertext (not legacy plaintext). */
    public boolean isEncrypted(String value) {
        return value != null && value.startsWith(PREFIX);
    }

    /** Encrypt plaintext. Null/empty pass through; an already-encrypted value is returned unchanged. */
    public String encrypt(String plain) {
        if (plain == null || plain.isEmpty() || isEncrypted(plain)) return plain;
        try {
            byte[] iv = new byte[IV_LEN];
            random.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return PREFIX + Base64.getEncoder().encodeToString(out);
        } catch (Exception e) {
            throw new IllegalStateException("Encryption failed", e);
        }
    }

    /** Decrypt a ciphertext produced by {@link #encrypt}. Legacy plaintext (no marker) passes through. */
    public String decrypt(String stored) {
        if (stored == null || !isEncrypted(stored)) return stored;
        try {
            byte[] all = Base64.getDecoder().decode(stored.substring(PREFIX.length()));
            byte[] iv = Arrays.copyOfRange(all, 0, IV_LEN);
            byte[] ct = Arrays.copyOfRange(all, IV_LEN, all.length);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            return new String(c.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // Wrong key or corrupt data — don't crash reads; surface as null so callers treat it as "no token".
            log.error("Failed to decrypt a stored secret (wrong app.encryption.key?): {}", e.toString());
            return null;
        }
    }
}
