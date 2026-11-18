package io.reporthub.reportstudio.acl;

import io.reporthub.reportstudio.iam.CurrentPrincipal;
import io.reporthub.reportstudio.iam.RhPrincipal;
import jakarta.persistence.criteria.CriteriaBuilder;
import jakarta.persistence.criteria.Expression;
import jakarta.persistence.criteria.Predicate;
import jakarta.persistence.criteria.Root;
import jakarta.persistence.criteria.Subquery;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/** Level 2 object ACLs for the current caller. */
@Service
public class AclService {

    private final AclEntryRepository repo;

    public AclService(AclEntryRepository repo) {
        this.repo = repo;
    }

    public static AclRules.Grant grant(AclEntry e) {
        return new AclRules.Grant(e.getPrincipalType(), e.getPrincipalCode(), e.getPermission());
    }

    /** Callers without a principal (system work) are not restricted here. */
    public boolean allowed(String type, String id, String perm) {
        RhPrincipal p = CurrentPrincipal.get().orElse(null);
        if (p == null || p.admin()) return true;
        return AclRules.allowed(repo.findByObjectTypeAndObjectIdOrderById(type, id).stream().map(AclService::grant).toList(), p, perm);
    }

    /** 403 unless allowed. */
    public void require(String type, String id, String perm) {
        if (!allowed(type, id, perm)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "No " + perm + " access to " + type.toLowerCase(Locale.ROOT) + " " + id);
        }
    }

    /** Keep the items the caller may {@code perm}; one ACL read per call. */
    public <T> List<T> filter(String type, Collection<T> items, Function<T, String> idOf, String perm) {
        RhPrincipal p = CurrentPrincipal.get().orElse(null);
        if (p == null || p.admin()) return new ArrayList<>(items);
        Map<String, List<AclRules.Grant>> byId = repo.findByObjectType(type).stream()
                .collect(Collectors.groupingBy(AclEntry::getObjectId, Collectors.mapping(AclService::grant, Collectors.toList())));
        return items.stream().filter(it -> AclRules.allowed(byId.get(idOf.apply(it)), p, perm)).toList();
    }

    /**
     * Query-side variant for paged lists: open objects, or objects with a matching grant.
     * {@code idPath} is the attribute holding the object id (e.g. {@code "code"}).
     */
    public <T> Specification<T> visible(String type, String idPath, String perm) {
        RhPrincipal p = CurrentPrincipal.get().orElse(null);
        if (p == null || p.admin()) return null;
        return (root, query, cb) -> {
            Expression<String> id = root.get(idPath).as(String.class);
            Subquery<Long> any = query.subquery(Long.class);
            Root<AclEntry> a = any.from(AclEntry.class);
            any.select(a.get("id")).where(cb.equal(a.get("objectType"), type), cb.equal(a.get("objectId"), id));

            Subquery<Long> mine = query.subquery(Long.class);
            Root<AclEntry> b = mine.from(AclEntry.class);
            List<Predicate> who = new ArrayList<>();
            who.add(cb.and(cb.equal(b.get("principalType"), "user"), cb.equal(b.get("principalCode"), p.username())));
            if (!p.roles().isEmpty()) who.add(cb.and(cb.equal(b.get("principalType"), "role"), b.get("principalCode").in(p.roles())));
            if (!p.responsibilities().isEmpty()) who.add(cb.and(cb.equal(b.get("principalType"), "responsibility"), b.get("principalCode").in(p.responsibilities())));
            mine.select(b.get("id")).where(cb.equal(b.get("objectType"), type), cb.equal(b.get("objectId"), id),
                    b.get("permission").in(AclRules.atLeast(perm)), cb.or(who.toArray(new Predicate[0])));
            return cb.or(cb.not(cb.exists(any)), cb.exists(mine));
        };
    }

    public List<AclEntry> list(String type, String id) {
        return repo.findByObjectTypeAndObjectIdOrderById(type, id);
    }

    @Transactional
    public List<AclEntry> replace(String type, String id, List<AclRules.Grant> grants, String by) {
        validate(type);
        repo.deleteByObjectTypeAndObjectId(type, id);
        repo.flush();
        List<AclEntry> out = new ArrayList<>();
        for (AclRules.Grant g : grants) {
            String pt = g.principalType() == null ? "" : g.principalType().trim().toLowerCase(Locale.ROOT);
            if (!AclRules.PRINCIPAL_TYPES.contains(pt)) throw new IllegalArgumentException("Unknown principal type: " + g.principalType());
            if (g.principalCode() == null || g.principalCode().isBlank()) throw new IllegalArgumentException("Principal code is required");
            AclRules.rank(g.permission());
            AclEntry e = new AclEntry();
            e.setObjectType(type);
            e.setObjectId(id);
            e.setPrincipalType(pt);
            e.setPrincipalCode(g.principalCode().trim());
            e.setPermission(g.permission().toLowerCase(Locale.ROOT));
            e.setCreatedBy(by);
            out.add(repo.save(e));
        }
        return out;
    }

    public static void validate(String type) {
        if (!AclRules.TYPES.contains(type)) throw new IllegalArgumentException("Unknown object type: " + type);
    }
}
