package io.reporthub.reportstudio.integration;

import io.reporthub.reportstudio.security.EncryptionService;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Secret handling for connector configs. Secret keys (per connector type) are stored encrypted with
 * {@link EncryptionService}, never returned by the API (replaced by {@link #MASK}) and kept unchanged
 * when an update sends the mask or a blank value.
 */
public final class ConnectorConfig {

    /** What the API shows instead of a stored secret. */
    public static final String MASK = "••• set";

    private ConnectorConfig() {}

    /** Config keys holding secrets for a connector type. */
    public static Set<String> secretKeys(String type) {
        return switch (type == null ? "" : type) {
            case ConnectorTypes.FILEHUB -> Set.of("apiKey");
            default -> Set.of();
        };
    }

    /** Copy of {@code stored} with secret values replaced by {@link #MASK} (absent/blank secrets are omitted). */
    public static Map<String, Object> mask(String type, Map<String, Object> stored) {
        Map<String, Object> out = new LinkedHashMap<>();
        Set<String> secrets = secretKeys(type);
        if (stored == null) return out;
        stored.forEach((k, v) -> {
            if (secrets.contains(k)) {
                if (v != null && !String.valueOf(v).isBlank()) out.put(k, MASK);
            } else {
                out.put(k, v);
            }
        });
        return out;
    }

    /**
     * Merge an update into the stored config: secrets sent as {@link #MASK}/blank/absent keep the stored
     * (encrypted) value; new secret values are encrypted. Non-secret keys are replaced as sent.
     */
    public static Map<String, Object> merge(String type, Map<String, Object> stored, Map<String, Object> incoming,
                                            EncryptionService enc) {
        Map<String, Object> out = new LinkedHashMap<>();
        Set<String> secrets = secretKeys(type);
        if (incoming != null) {
            incoming.forEach((k, v) -> {
                if (!secrets.contains(k)) out.put(k, v);
            });
        }
        for (String k : secrets) {
            Object nv = incoming == null ? null : incoming.get(k);
            String s = nv == null ? "" : String.valueOf(nv);
            if (s.isBlank() || MASK.equals(s)) {
                Object old = stored == null ? null : stored.get(k);
                if (old != null && !String.valueOf(old).isBlank()) out.put(k, enc.encrypt(String.valueOf(old)));
            } else {
                out.put(k, enc.encrypt(s.trim()));
            }
        }
        return out;
    }

    /** Plain value of a (possibly encrypted) secret, or "". */
    public static String secret(Map<String, Object> stored, String key, EncryptionService enc) {
        Object v = stored == null ? null : stored.get(key);
        if (v == null) return "";
        String d = enc.decrypt(String.valueOf(v));
        return d == null ? "" : d;
    }
}
