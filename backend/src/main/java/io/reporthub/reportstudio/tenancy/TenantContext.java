package io.reporthub.reportstudio.tenancy;

import java.util.Optional;
import java.util.function.Supplier;

/**
 * Request- (or job-) scoped tenant + project selection.
 *
 * <p>Set by {@link TenantContextFilter} for HTTP requests (tenant from the caller's identity,
 * project from the {@code X-Project} header / {@code project} query parameter) and by background
 * workers from the row they are processing. When it is set, every JPA transaction enables the
 * Hibernate {@code tenantScope} filter (see {@link TenantAwareTransactionManager}) so repositories
 * only see rows of that tenant + project, and new rows are stamped with it (see
 * {@link TenantScopeListener}). When it is not set (system timers) nothing is filtered.
 */
public final class TenantContext {

    public static final String DEFAULT_TENANT = "default";
    public static final String DEFAULT_PROJECT = "default";

    public record Scope(String tenantId, String projectId) {
        public Scope {
            if (tenantId == null || tenantId.isBlank()) throw new IllegalArgumentException("tenantId required");
            if (projectId == null || projectId.isBlank()) throw new IllegalArgumentException("projectId required");
        }
    }

    private static final ThreadLocal<Scope> CURRENT = new ThreadLocal<>();

    private TenantContext() {}

    public static Optional<Scope> current() {
        return Optional.ofNullable(CURRENT.get());
    }

    public static void set(Scope scope) {
        if (scope == null) CURRENT.remove(); else CURRENT.set(scope);
    }

    public static void clear() {
        CURRENT.remove();
    }

    /** Run {@code work} with {@code scope} set, restoring whatever was there before. */
    public static <T> T callAs(Scope scope, Supplier<T> work) {
        Scope prev = CURRENT.get();
        set(scope);
        try {
            return work.get();
        } finally {
            set(prev);
        }
    }

    public static void runAs(Scope scope, Runnable work) {
        callAs(scope, () -> { work.run(); return null; });
    }

    /** Scope of a stored row, defaulting blanks so legacy rows still resolve. */
    public static Scope of(String tenantId, String projectId) {
        return new Scope(blank(tenantId) ? DEFAULT_TENANT : tenantId, blank(projectId) ? DEFAULT_PROJECT : projectId);
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
