package io.reporthub.reportstudio.repo;

import jakarta.persistence.criteria.Predicate;
import org.springframework.data.jpa.domain.Specification;
import io.reporthub.reportstudio.domain.Report;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * Registry-list filters, composed into the WHERE clause only when they are actually
 * supplied. The previous JPQL carried every filter as a {@code :p IS NULL OR col = :p}
 * guard, which forces one plan to serve every combination; building the predicates here
 * means an unfiltered list and a filtered one are separate statements.
 */
public final class ReportSpecs {

    private ReportSpecs() {
    }

    public static Specification<Report> search(String category, String status, String engine,
                                               String datasource, String q) {
        return (root, query, cb) -> {
            List<Predicate> where = new ArrayList<>();
            if (category != null) where.add(cb.equal(root.get("categoryId"), category));
            if (status != null) where.add(cb.equal(root.get("status"), status));
            if (engine != null) where.add(cb.equal(root.get("engine"), engine));
            if (datasource != null) where.add(cb.equal(root.get("datasourceId"), datasource));
            if (q != null) {
                String like = "%" + q.toLowerCase() + "%";
                where.add(cb.or(
                        cb.like(cb.lower(root.get("name")), like),
                        cb.like(cb.lower(root.get("code")), like)));
            }
            return where.isEmpty() ? null : cb.and(where.toArray(new Predicate[0]));
        };
    }

    /**
     * Restrict the list to what a portal caller may see: a report with no
     * {@code allowed_roles} is public, otherwise the caller must hold one of the listed
     * portal role codes. Matching is done on a comma-wrapped string so {@code ANALYST}
     * never matches {@code ANALYST-II}.
     *
     * <p>Callers with no portal identity (a direct {@code admin/admin} login — no
     * gateway token, so no roles claim) must not reach this at all; the
     * service leaves the specification off entirely for them.
     */
    public static Specification<Report> visibleTo(Collection<String> roleCodes) {
        return (root, query, cb) -> {
            Predicate open = cb.or(
                    cb.isNull(root.get("allowedRoles")),
                    cb.equal(root.get("allowedRoles"), ""));
            List<Predicate> granted = new ArrayList<>();
            for (String role : roleCodes) {
                if (role == null || role.isBlank()) continue;
                // stored as "A,B"; compare against ",A,B," so a whole code must match
                granted.add(cb.like(
                        cb.concat(cb.concat(cb.literal(","), root.get("allowedRoles")), ","),
                        "%," + role.trim() + ",%"));
            }
            if (granted.isEmpty()) return open;
            granted.add(open);
            return cb.or(granted.toArray(new Predicate[0]));
        };
    }
}
