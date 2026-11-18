package io.reporthub.reportstudio.integration;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.reporthub.reportstudio.security.EncryptionService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/** Rows of the {@code connector} table. Configs are kept as stored (secrets encrypted). */
@Component
public class ConnectorStore {

    public record Row(String id, String type, String name, Map<String, Object> config, boolean enabled,
                      String status, OffsetDateTime lastCheckedAt, String lastError, String scope,
                      String tenantId, OffsetDateTime updatedAt, String updatedBy) {

        public String str(String key) {
            Object v = config == null ? null : config.get(key);
            return v == null ? "" : String.valueOf(v).trim();
        }
    }

    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {};

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final EncryptionService enc;
    /** Short read-through cache by id (read on every IAM call / render; other pods see changes within the TTL). */
    private record Cached(Optional<Row> row, long at) {}
    private static final long TTL_MS = 15_000;
    private final Map<String, Cached> cache = new ConcurrentHashMap<>();

    public ConnectorStore(JdbcTemplate jdbc, ObjectMapper json, EncryptionService enc) {
        this.jdbc = jdbc;
        this.json = json;
        this.enc = enc;
    }

    public EncryptionService encryption() { return enc; }

    public List<Row> list() {
        return jdbc.query("SELECT * FROM connector ORDER BY type, name", this::map);
    }

    public List<Row> byType(String type) {
        return jdbc.query("SELECT * FROM connector WHERE type = ? ORDER BY name", this::map, type);
    }

    public Optional<Row> find(String id) {
        if (id == null) return Optional.empty();
        Cached c = cache.get(id);
        long now = System.currentTimeMillis();
        if (c != null && now - c.at() < TTL_MS) return c.row();
        Optional<Row> r;
        try {
            r = jdbc.query("SELECT * FROM connector WHERE id = ?", this::map, id).stream().findFirst();
        } catch (Exception e) {
            r = Optional.empty(); // table missing during early startup
        }
        cache.put(id, new Cached(r, now));
        return r;
    }

    /** Insert or replace a connector; {@code config} must already be merged/encrypted. */
    public Row upsert(String id, String type, String name, Map<String, Object> config, boolean enabled, String by) {
        String cfg = write(config);
        int n = jdbc.update("UPDATE connector SET name = ?, config = ?::jsonb, enabled = ?, updated_at = now(), updated_by = ? WHERE id = ?",
                name, cfg, enabled, by, id);
        if (n == 0) {
            jdbc.update("INSERT INTO connector (id, type, name, config, enabled, updated_by) VALUES (?, ?, ?, ?::jsonb, ?, ?)",
                    id, type, name, cfg, enabled, by);
        }
        cache.remove(id);
        return find(id).orElseThrow();
    }

    public void recordCheck(String id, boolean ok, String error) {
        jdbc.update("UPDATE connector SET status = ?, last_checked_at = now(), last_error = ? WHERE id = ?",
                ok ? "healthy" : "down", ok ? null : error, id);
        cache.remove(id);
    }

    public void delete(String id) {
        jdbc.update("DELETE FROM connector WHERE id = ?", id);
        cache.remove(id);
    }

    /** Decrypted secret of a stored connector. */
    public String secret(Row r, String key) { return ConnectorConfig.secret(r.config(), key, enc); }

    private String write(Map<String, Object> m) {
        try { return json.writeValueAsString(m == null ? Map.of() : m); }
        catch (Exception e) { throw new IllegalArgumentException("Invalid connector config", e); }
    }

    private Row map(ResultSet rs, int i) throws SQLException {
        Map<String, Object> cfg;
        try {
            String raw = rs.getString("config");
            cfg = raw == null ? Map.of() : json.readValue(raw, MAP);
        } catch (Exception e) {
            cfg = Map.of();
        }
        return new Row(rs.getString("id"), rs.getString("type"), rs.getString("name"), cfg, rs.getBoolean("enabled"),
                rs.getString("status"), rs.getObject("last_checked_at", OffsetDateTime.class), rs.getString("last_error"),
                rs.getString("scope"), rs.getString("tenant_id"), rs.getObject("updated_at", OffsetDateTime.class),
                rs.getString("updated_by"));
    }
}
