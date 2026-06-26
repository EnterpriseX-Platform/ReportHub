package io.reporthub.reportstudio.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.repo.EngineInstanceRepository;

import java.util.List;

/**
 * One-time, idempotent migration: encrypt any engine authTokens still stored as legacy plaintext.
 *
 * <p>We read and write the raw column with native SQL (bypassing the encrypting converter): a normal
 * load+save would be a no-op here because Hibernate dirty-checks the DECRYPTED attribute, which is
 * unchanged for a plaintext row. After migration no rows match and this is a no-op. Legacy plaintext
 * rows keep working until migrated because the converter passes unmarked values through on read.
 */
@Component
public class AuthTokenMigration implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AuthTokenMigration.class);

    private final EngineInstanceRepository repo;
    private final EncryptionService encryption;

    public AuthTokenMigration(EngineInstanceRepository repo, EncryptionService encryption) {
        this.repo = repo;
        this.encryption = encryption;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        List<Long> ids = repo.findIdsWithPlaintextToken();
        int migrated = 0;
        for (Long id : ids) {
            String raw = repo.rawAuthToken(id);
            if (raw == null || raw.isBlank() || encryption.isEncrypted(raw)) continue;
            repo.updateRawAuthToken(id, encryption.encrypt(raw));
            migrated++;
        }
        if (migrated > 0) {
            log.info("Encrypted {} legacy plaintext engine authToken(s) at startup", migrated);
        }

        // Health check: warn loudly if an already-encrypted token can't be decrypted (wrong
        // ENCRYPTION_KEY / key rotated without re-encryption) — otherwise it silently becomes "no token".
        int unrecoverable = 0;
        for (Long id : repo.findIdsWithToken()) {
            String raw = repo.rawAuthToken(id);
            if (encryption.isEncrypted(raw) && encryption.decrypt(raw) == null) unrecoverable++;
        }
        if (unrecoverable > 0) {
            log.warn("{} engine authToken(s) cannot be decrypted — check ENCRYPTION_KEY (was the key rotated?)",
                    unrecoverable);
        }
    }
}
