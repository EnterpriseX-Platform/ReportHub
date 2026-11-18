package io.reporthub.reportstudio.iam;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** {@code app.auth.mode}: {@code local} (built-in users, default) or {@code iam}. */
@Component
public class AuthMode {

    private final String mode;

    public AuthMode(@Value("${app.auth.mode:local}") String mode) {
        this.mode = mode == null ? "local" : mode.trim().toLowerCase();
    }

    public boolean isIam() { return "iam".equals(mode); }
    public String value() { return mode; }
}
