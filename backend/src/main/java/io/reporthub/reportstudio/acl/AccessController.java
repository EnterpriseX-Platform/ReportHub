package io.reporthub.reportstudio.acl;

import io.reporthub.reportstudio.iam.CurrentPrincipal;
import io.reporthub.reportstudio.iam.RhPrincipal;
import io.reporthub.reportstudio.rowfilter.RowFilterRule;
import io.reporthub.reportstudio.rowfilter.RowFilterRuleRepository;
import io.reporthub.reportstudio.rowfilter.RowFilterService;
import io.reporthub.reportstudio.rowfilter.RowFilterSql;
import io.reporthub.reportstudio.web.BadRequestException;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Access tab endpoints: object ACLs ({@code /acl/{type}/{id}}) and row-filter rules
 * ({@code /row-filters/{type}/{id}}) with a "preview as user" check.
 */
@RestController
public class AccessController {

    public record GrantBody(String principalType, String principalCode, String permission) {}
    public record RuleBody(String column, String operator, String valueExpr, String valueType,
                           String principalType, String principalCode, Boolean enabled) {}
    public record PreviewBody(String username, List<String> roles, List<String> responsibilities,
                              Map<String, String> attributes, String sql) {}

    private static final Set<String> RF_TYPES = Set.of(RowFilterService.REPORT, RowFilterService.DATASET, RowFilterService.REPO_TABLE);

    private final AclService acl;
    private final RowFilterRuleRepository rules;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.service.DatasetService datasets;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.repo.RepoTableRepository registry;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.service.RepositoryService repository;

    /** Column name -> numeric? for the filtered object, or null when it cannot be determined. */
    private java.util.Map<String, Boolean> columnsOf(String type, String id) {
        try {
            java.util.Map<String, Boolean> out = new java.util.TreeMap<>(String.CASE_INSENSITIVE_ORDER);
            if (RowFilterService.DATASET.equals(type) && datasets != null) {
                for (var c : datasets.fields(datasets.require(Long.valueOf(id)))) out.put(c.name(), "measure".equals(c.kind()));
                return out;
            }
            if (RowFilterService.REPO_TABLE.equals(type) && registry != null && repository != null) {
                var e = registry.findById(Integer.valueOf(id)).orElse(null);
                if (e == null) return null;
                var m = repository.meta(e.getDatasourceId(), e.getSchemaName(), e.getTableName());
                for (var c : m.columns()) out.put(c.name(), io.reporthub.reportstudio.util.TypedValues.isNumeric(c.sqlType()));
                return out;
            }
        } catch (Exception ignored) {
            // metadata unavailable (datasource down etc.): fall back to syntax checks only
        }
        return null;
    }

    /** Number-typed values: each item must be a number or a ${user.x} reference. */
    public static void validateNumberValues(String valueExpr) {
        if (valueExpr == null) return;
        for (String item : valueExpr.split(",")) {
            String t = item.trim();
            if (t.isEmpty() || t.matches("\\$\\{user\\.[A-Za-z0-9_.-]{1,64}}")) continue;
            if (!t.matches("[-+]?\\d+(\\.\\d+)?")) {
                throw new BadRequestException("Value '" + t + "' is not a number (numeric column / number value type)");
            }
        }
    }

    public AccessController(AclService acl, RowFilterRuleRepository rules) {
        this.acl = acl;
        this.rules = rules;
    }

    @GetMapping("/acl/meta")
    public Map<String, Object> meta() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("objectTypes", AclRules.TYPES);
        m.put("permissions", AclRules.PERMISSIONS);
        m.put("principalTypes", List.of("role", "responsibility", "user"));
        m.put("rowFilterTypes", RF_TYPES);
        m.put("operators", List.of("=", "<>", "<", "<=", ">", ">=", "IN", "NOT IN", "LIKE", "IS NULL", "IS NOT NULL"));
        m.put("attributes", List.of("username", "tenant", "departmentCode", "positionCode", "employeeCode", "email", "userId"));
        return m;
    }

    @GetMapping("/acl/{type}/{id}")
    public List<AclEntry> getAcl(@PathVariable String type, @PathVariable String id) {
        String t = type(type);
        AclService.validate(t);
        return acl.list(t, id);
    }

    @PutMapping("/acl/{type}/{id}")
    public List<AclEntry> putAcl(@PathVariable String type, @PathVariable String id, @RequestBody List<GrantBody> body) {
        String t = type(type);
        try {
            return acl.replace(t, id, body.stream().map(g -> new AclRules.Grant(g.principalType(), g.principalCode(), g.permission())).toList(), who());
        } catch (IllegalArgumentException e) {
            throw new BadRequestException(e.getMessage());
        }
    }

    @GetMapping("/row-filters/{type}/{id}")
    public List<RowFilterRule> getRules(@PathVariable String type, @PathVariable String id) {
        return rules.findByObjectTypeAndObjectIdOrderById(rfType(type), id);
    }

    @PutMapping("/row-filters/{type}/{id}")
    @Transactional
    public List<RowFilterRule> putRules(@PathVariable String type, @PathVariable String id, @RequestBody List<RuleBody> body) {
        String t = rfType(type);
        List<RowFilterRule> fresh = new ArrayList<>();
        for (RuleBody b : body) fresh.add(toEntity(t, id, b));
        rules.deleteByObjectTypeAndObjectId(t, id);
        rules.flush();
        return rules.saveAll(fresh);
    }

    /**
     * Compile the saved rules (or {@code sql} wrapped with them) as a hypothetical user would get
     * them. Returns the SQL and the bind values, so an admin can check a rule before relying on it.
     */
    @PostMapping("/row-filters/{type}/{id}/preview")
    public Map<String, Object> preview(@PathVariable String type, @PathVariable String id, @RequestBody PreviewBody b) {
        String t = rfType(type);
        RhPrincipal as = new RhPrincipal(b.username() == null || b.username().isBlank() ? "preview" : b.username(),
                null, "preview", CurrentPrincipal.get().map(RhPrincipal::tenantId).orElse(null), false,
                b.roles() == null ? null : Set.copyOf(b.roles()),
                b.responsibilities() == null ? null : Set.copyOf(b.responsibilities()),
                b.attributes(), Map.of());
        List<RowFilterSql.Rule> rs = rules.findByObjectTypeAndObjectIdOrderById(t, id).stream()
                .filter(RowFilterRule::isEnabled).map(RowFilterService::toRule).toList();
        try {
            RowFilterSql.Condition c = RowFilterSql.compile(rs, as, RowFilterSql.quoted("rf_q."), v -> "?");
            String base = b.sql() == null || b.sql().isBlank() ? sourceSql(t, id) : b.sql();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("condition", c.sql());
            out.put("binds", c.binds().stream().map(String::valueOf).toList());
            out.put("sql", RowFilterSql.wrap(base, c));
            out.put("filtered", !c.isEmpty());
            out.put("effectiveSql", out.get("sql"));
            out.put("params", out.get("binds"));
            out.put("denied", c.sql().contains("(1=0)"));
            return out;
        } catch (IllegalArgumentException e) {
            throw new BadRequestException(e.getMessage());
        }
    }

    /** The object's own query (dataset SQL / registered table) for "preview as user". */
    private String sourceSql(String type, String id) {
        try {
            if (RowFilterService.DATASET.equals(type) && datasets != null) return datasets.require(Long.valueOf(id)).getSqlText();
            if (RowFilterService.REPO_TABLE.equals(type) && registry != null) {
                var e = registry.findById(Integer.valueOf(id)).orElse(null);
                if (e != null) return "SELECT * FROM " + (e.getSchemaName() == null ? "" : "\"" + e.getSchemaName() + "\".")
                        + "\"" + e.getTableName() + "\"";
            }
        } catch (Exception ignored) { /* fall through */ }
        return "<source query>";
    }

    private RowFilterRule toEntity(String type, String id, RuleBody b) {
        if (!RowFilterSql.validColumn(b.column())) throw new BadRequestException("Invalid column name: " + b.column());
        String op;
        try { op = RowFilterSql.normalizeOperator(b.operator()); } catch (IllegalArgumentException e) { throw new BadRequestException(e.getMessage()); }
        boolean needsValue = !op.startsWith("IS ");
        if (needsValue && (b.valueExpr() == null || b.valueExpr().isBlank())) throw new BadRequestException("Value is required for " + op);
        String vt = b.valueType() == null || b.valueType().isBlank() ? "text" : b.valueType().toLowerCase(Locale.ROOT);
        if (!vt.equals("text") && !vt.equals("number")) throw new BadRequestException("Value type must be text or number");
        String column = b.column();
        java.util.Map<String, Boolean> cols = columnsOf(type, id);
        if (cols != null) {
            String canonical = cols.keySet().stream().filter(c -> c.equalsIgnoreCase(b.column())).findFirst()
                    .orElseThrow(() -> new BadRequestException("Unknown column '" + b.column() + "'. Columns: "
                            + String.join(", ", cols.keySet())));
            column = canonical;
            if (Boolean.TRUE.equals(cols.get(canonical))) vt = "number";   // numeric column: values must be numbers
        }
        if (needsValue && "number".equals(vt)) validateNumberValues(b.valueExpr());
        String pt = b.principalType() == null || b.principalType().isBlank() ? null : b.principalType().toLowerCase(Locale.ROOT);
        if (pt != null && !AclRules.PRINCIPAL_TYPES.contains(pt)) throw new BadRequestException("Unknown principal type: " + pt);
        RowFilterRule r = new RowFilterRule();
        r.setObjectType(type);
        r.setObjectId(id);
        r.setColumnName(column);
        r.setOperator(op);
        r.setValueExpr(needsValue ? b.valueExpr().trim() : null);
        r.setValueType(vt);
        r.setPrincipalType(pt);
        r.setPrincipalCode(pt == null ? null : b.principalCode());
        r.setEnabled(b.enabled() == null || b.enabled());
        r.setCreatedBy(who());
        r.setUpdatedAt(OffsetDateTime.now());
        return r;
    }

    private static String type(String t) { return t == null ? "" : t.toUpperCase(Locale.ROOT).replace('-', '_'); }

    private static String rfType(String t) {
        String v = type(t);
        if (!RF_TYPES.contains(v)) throw new BadRequestException("Row filters apply to REPORT, DATASET or REPO_TABLE");
        return v;
    }

    private static String who() {
        return CurrentPrincipal.get().map(RhPrincipal::username).orElse("system");
    }
}
