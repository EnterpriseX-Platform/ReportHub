package io.reporthub.reportstudio.service;

import io.reporthub.reportstudio.iam.CurrentPrincipal;
import io.reporthub.reportstudio.iam.RhPrincipal;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Keeps non-admin callers away from the application's own database and from database-internal
 * schemas. A datasource whose JDBC URL resolves to the same host:port/database as
 * {@code spring.datasource.url} is "internal": only ReportHub admins may create, edit or read through it.
 */
@Component
public class AppDatabaseGuard {

    private static volatile String appUrl;

    public AppDatabaseGuard(@Value("${spring.datasource.url:}") String url) {
        appUrl = url;
    }

    /** For tests. */
    public static void setAppUrl(String url) { appUrl = url; }

    private static final Pattern URL = Pattern.compile(
            "(?i)^jdbc:(postgresql|mysql|mariadb)://([^/?;,]+?)(?::(\\d+))?/([^?;]*)");

    /** {@code engine|host|port|db} with loopback names folded together; null when not parseable. */
    static String endpoint(String jdbcUrl) {
        if (jdbcUrl == null) return null;
        Matcher m = URL.matcher(jdbcUrl.trim());
        if (!m.find()) return null;
        String engine = m.group(1).toLowerCase(Locale.ROOT);
        if (engine.equals("mariadb")) engine = "mysql";
        String host = m.group(2).toLowerCase(Locale.ROOT).replaceAll("^\\[|]$", "");
        if (host.equals("localhost") || host.equals("127.0.0.1") || host.equals("::1") || host.equals("0.0.0.0")
                || host.equals("host.docker.internal") || host.startsWith("127.")) host = "loopback";
        String port = m.group(3) != null ? m.group(3) : engine.equals("postgresql") ? "5432" : "3306";
        String db = m.group(4).toLowerCase(Locale.ROOT);
        return engine + "|" + host + "|" + port + "|" + db;
    }

    /** True when {@code jdbcUrl} points at the application's own database. */
    public static boolean isAppDatabase(String jdbcUrl) {
        String a = endpoint(appUrl), b = endpoint(jdbcUrl);
        return a != null && a.equals(b);
    }

    static boolean callerIsAdmin() {
        RhPrincipal p = CurrentPrincipal.get().orElse(null);
        return p == null || p.admin();   // no principal = system work (scheduler, worker)
    }

    /** 403 for a non-admin creating/editing/using a datasource that points at the app database. */
    public static void checkDatasourceUrl(String jdbcUrl) {
        if (!callerIsAdmin() && isAppDatabase(jdbcUrl)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "This connection points at the ReportHub application database; only administrators may use it");
        }
    }

    public static boolean isInternalSchema(String schema) {
        if (schema == null) return false;
        String s = schema.toLowerCase(Locale.ROOT);
        return s.equals("pg_catalog") || s.equals("information_schema") || s.startsWith("pg_toast")
                || s.startsWith("pg_temp") || s.equals("sys") || s.equals("system") || s.equals("mysql")
                || s.equals("performance_schema");
    }

    /** 403 for a non-admin reading a database-internal schema. */
    public static void checkSchema(String schema) {
        if (!callerIsAdmin() && isInternalSchema(schema)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Internal schema is not available: " + schema);
        }
    }

    private static final Pattern INTERNAL_REF = Pattern.compile(
            "(?i)(?<![\\w$])(pg_catalog|information_schema|performance_schema|pg_(?:shadow|authid|user|roles|stat_\\w+|settings|database|namespace|class|proc|auth_members|file_settings|hba_file_rules)|sys\\s*\\.|dba_\\w+|v\\$\\w+)(?![\\w$])");

    /** 403 for a non-admin statement that references internal catalogs. */
    public static void checkSql(String sql) {
        if (sql != null && !callerIsAdmin() && INTERNAL_REF.matcher(sql).find()) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Statements on database-internal catalogs are for administrators only");
        }
    }
}
