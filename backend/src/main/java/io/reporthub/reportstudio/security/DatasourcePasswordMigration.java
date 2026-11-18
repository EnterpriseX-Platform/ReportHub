package io.reporthub.reportstudio.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Startup, idempotent: encrypt datasource passwords still stored as plaintext. Reads/writes the raw
 * column with native SQL (the entity converter would see no change for a plaintext row). Plaintext
 * rows keep working until migrated because the converter passes unmarked values through on read.
 */
@Component
public class DatasourcePasswordMigration implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DatasourcePasswordMigration.class);

    private final JdbcTemplate jdbc;
    private final EncryptionService encryption;

    public DatasourcePasswordMigration(JdbcTemplate jdbc, EncryptionService encryption) {
        this.jdbc = jdbc;
        this.encryption = encryption;
    }

    @Override
    public void run(ApplicationArguments args) {
        List<Map<String, Object>> rows;
        try {
            rows = jdbc.queryForList("SELECT id, db_password FROM datasource WHERE db_password IS NOT NULL AND db_password <> ''");
        } catch (Exception e) {
            log.warn("Datasource password migration skipped: {}", e.toString());
            return;
        }
        int n = 0;
        for (Map<String, Object> r : rows) {
            String raw = (String) r.get("db_password");
            if (raw == null || encryption.isEncrypted(raw)) continue;
            jdbc.update("UPDATE datasource SET db_password = ? WHERE id = ?", encryption.encrypt(raw), r.get("id"));
            n++;
        }
        if (n > 0) log.info("Encrypted {} plaintext datasource password(s) at startup", n);
    }
}
