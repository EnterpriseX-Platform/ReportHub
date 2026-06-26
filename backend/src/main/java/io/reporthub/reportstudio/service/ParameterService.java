package io.reporthub.reportstudio.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.ParamDef;
import io.reporthub.reportstudio.domain.ReportParam;
import io.reporthub.reportstudio.dto.ParamDefDto;
import io.reporthub.reportstudio.dto.ParamOptionDto;
import io.reporthub.reportstudio.dto.ReportParamAssignment;
import io.reporthub.reportstudio.dto.SaveParamRequest;
import io.reporthub.reportstudio.repo.ParamDefRepository;
import io.reporthub.reportstudio.repo.ReportParamRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;

import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Parameter catalog: definitions, per-report assignment, and option resolution.
 *
 * Query-sourced options run a real SELECT against a lookup table. Identifiers are never
 * concatenated from user input unchecked: the table must be on the {@link #LOOKUP_TABLES}
 * allowlist and every column must match {@link #IDENT}; the parent value itself is bound
 * as a JDBC parameter.
 */
@Service
@Transactional(readOnly = true)
public class ParameterService {

    /** Tables a query-sourced parameter may never read (credentials, framework state). */
    private static final Set<String> DENY_TABLES = Set.of("app_user", "flyway_schema_history");
    private static final Pattern IDENT = Pattern.compile("[a-z_][a-z0-9_]*");

    private final ParamDefRepository defs;
    private final ReportParamRepository assignments;
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final DatasetService datasetService;

    public ParameterService(ParamDefRepository defs,
                            ReportParamRepository assignments,
                            JdbcTemplate jdbc,
                            ObjectMapper json,
                            DatasetService datasetService) {
        this.defs = defs;
        this.assignments = assignments;
        this.jdbc = jdbc;
        this.json = json;
        this.datasetService = datasetService;
    }

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(ParameterService.class);

    // ---- run-param validation ------------------------------------------------

    /** Declared parameter names for a report, from its parameter-catalog assignment. */
    public Set<String> declaredParamNames(String reportCode) {
        return assignments.findByReportCodeOrderBySortOrderAsc(reportCode)
                .stream().map(ReportParam::getParamName)
                .collect(java.util.stream.Collectors.toCollection(java.util.LinkedHashSet::new));
    }

    /**
     * Drop any run param the report does not declare in its catalog, so a caller can't inject extra
     * values an engine would substitute (e.g. into a SQL / api endpoint template). When the report
     * declares NO params we cannot validate against anything, so the map is returned unchanged — this
     * avoids breaking reports configured outside the catalog while still closing the injection vector
     * for every report that does declare its parameters.
     */
    public java.util.Map<String, Object> retainDeclared(String reportCode, java.util.Map<String, Object> params) {
        if (params == null || params.isEmpty()) return params;
        Set<String> declared = declaredParamNames(reportCode);
        if (declared.isEmpty()) return params;
        java.util.Map<String, Object> kept = new java.util.LinkedHashMap<>();
        java.util.List<String> dropped = new java.util.ArrayList<>();
        params.forEach((k, v) -> {
            if (declared.contains(k)) kept.put(k, v);
            else dropped.add(k);
        });
        if (!dropped.isEmpty()) {
            log.warn("Report {}: dropped undeclared run param(s) {}", reportCode, dropped);
        }
        return kept;
    }

    // ---- lookup-table discovery (for the catalog UI) -------------------------

    /** Tables in the internal warehouse a table-driven parameter may read. */
    public List<String> lookupTables() {
        return jdbc.queryForList("""
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                ORDER BY table_name""", String.class)
                .stream().filter(t -> !DENY_TABLES.contains(t)).toList();
    }

    /** Columns of a lookup table (for value/label/filter pickers). */
    public List<String> tableColumns(String table) {
        if (table == null || !IDENT.matcher(table).matches() || DENY_TABLES.contains(table)) {
            throw new BadRequestException("Table not allowed: " + table);
        }
        List<String> cols = jdbc.queryForList("""
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = ?
                ORDER BY ordinal_position""", String.class, table);
        if (cols.isEmpty()) throw new BadRequestException("Table not found: " + table);
        return cols.stream().filter(c -> !c.toLowerCase().contains("password")).toList();
    }

    // ---- catalog CRUD -------------------------------------------------------

    public List<ParamDefDto> list() {
        return defs.findAllByOrderBySortOrderAsc().stream().map(this::toDto).toList();
    }

    @Transactional
    public ParamDefDto create(SaveParamRequest req) {
        if (defs.existsByName(req.name())) {
            throw new BadRequestException("Parameter already exists: " + req.name());
        }
        ParamDef d = new ParamDef();
        apply(d, req);
        return toDto(defs.save(d));
    }

    @Transactional
    public ParamDefDto update(Long id, SaveParamRequest req) {
        ParamDef d = defs.findById(id)
                .orElseThrow(() -> new NotFoundException("Parameter not found: " + id));
        defs.findByName(req.name()).filter(o -> !o.getId().equals(id)).ifPresent(o -> {
            throw new BadRequestException("Parameter already exists: " + req.name());
        });
        apply(d, req);
        return toDto(defs.save(d));
    }

    @Transactional
    public void delete(Long id) {
        ParamDef d = defs.findById(id)
                .orElseThrow(() -> new NotFoundException("Parameter not found: " + id));
        defs.delete(d);
    }

    private void apply(ParamDef d, SaveParamRequest req) {
        if ("query".equals(req.sourceType())) {
            validateLookup(req.lookupTable(), req.valueColumn(), req.labelColumn(), req.filterColumn());
        }
        if ("sql".equals(req.sourceType())) {
            validateLookupSql(req.sourceSql());
        }
        if (("query".equals(req.sourceType()) || "sql".equals(req.sourceType()))
                && req.dependsOn() != null && !req.dependsOn().isBlank()
                && req.dependsOn().equals(req.name())) {
            throw new BadRequestException("Parameter cannot depend on itself");
        }
        d.setName(req.name());
        d.setLabel(req.label());
        d.setType(req.type());
        d.setRequired(req.required());
        d.setDefaultValue(blankToNull(req.defaultValue()));
        d.setSourceType(req.sourceType());
        d.setOptionsJson(req.staticOptions() == null || req.staticOptions().isEmpty()
                ? null : writeJson(req.staticOptions()));
        d.setLookupTable(blankToNull(req.lookupTable()));
        d.setSourceSql(blankToNull(req.sourceSql()));
        d.setDatasourceId(blankToNull(req.datasourceId()));
        d.setValueColumn(blankToNull(req.valueColumn()));
        d.setLabelColumn(blankToNull(req.labelColumn()));
        d.setDependsOn(blankToNull(req.dependsOn()));
        d.setFilterColumn(blankToNull(req.filterColumn()));
        d.setSortOrder(req.sortOrder() == null ? 0 : req.sortOrder());
    }

    // ---- option resolution (the cascade) -------------------------------------

    /** Options for a parameter; {@code parent} is the selected value of its dependsOn param. */
    public List<ParamOptionDto> options(String name, String parent) {
        ParamDef d = defs.findByName(name)
                .orElseThrow(() -> new NotFoundException("Parameter not found: " + name));

        if ("boolean".equals(d.getType()) && d.getOptionsJson() == null) {
            return List.of(new ParamOptionDto("true", "true"), new ParamOptionDto("false", "false"));
        }
        if ("static".equals(d.getSourceType())) {
            return d.getOptionsJson() == null ? List.of() : readOptions(d.getOptionsJson());
        }
        if ("sql".equals(d.getSourceType())) {
            return sqlOptions(d, parent);
        }

        validateLookup(d.getLookupTable(), d.getValueColumn(), d.getLabelColumn(), d.getFilterColumn());
        boolean cascade = d.getDependsOn() != null && d.getFilterColumn() != null;
        if (cascade && (parent == null || parent.isBlank())) {
            return List.of();   // wait for the parent selection
        }
        String sql = "SELECT DISTINCT " + d.getValueColumn() + " AS v, " + d.getLabelColumn() + " AS l"
                + " FROM " + d.getLookupTable()
                + (cascade ? " WHERE " + d.getFilterColumn() + " = ?" : "")
                + " ORDER BY 2 LIMIT 500";
        var mapper = (org.springframework.jdbc.core.RowMapper<ParamOptionDto>) (rs, i) ->
                new ParamOptionDto(rs.getString("v"), rs.getString("l"));
        return cascade ? jdbc.query(sql, mapper, parent) : jdbc.query(sql, mapper);
    }

    /** SQL-sourced options: SELECT value[, label] …; ':parent' binds the parent value. */
    private List<ParamOptionDto> sqlOptions(ParamDef d, String parent) {
        String sql = d.getSourceSql();
        if (sql == null || sql.isBlank()) return List.of();
        validateLookupSql(sql);
        List<Object> binds = new java.util.ArrayList<>();
        if (sql.contains(":parent")) {
            if (parent == null || parent.isBlank()) return List.of();   // wait for the parent
            int n = sql.split(":parent", -1).length - 1;
            for (int i = 0; i < n; i++) binds.add(parent);
            sql = sql.replace(":parent", "?");
        }
        DatasetService.TableResult res = datasetService.lookup(d.getDatasourceId(), sql, binds, 500);
        return res.rows().stream().map(r -> {
            String v = r.get(0) == null ? "" : String.valueOf(r.get(0));
            String l = r.size() > 1 && r.get(1) != null ? String.valueOf(r.get(1)) : v;
            return new ParamOptionDto(v, l);
        }).toList();
    }

    /** Resolve options for an UNSAVED definition (the editor's preview button). */
    public List<ParamOptionDto> previewOptions(SaveParamRequest req, String parent) {
        ParamDef d = new ParamDef();
        apply(d, req);
        if ("static".equals(d.getSourceType())) {
            return d.getOptionsJson() == null ? List.of() : readOptions(d.getOptionsJson());
        }
        if ("sql".equals(d.getSourceType())) return sqlOptions(d, parent);
        boolean cascade = d.getDependsOn() != null && d.getFilterColumn() != null;
        if (cascade && (parent == null || parent.isBlank())) return List.of();
        String sql = "SELECT DISTINCT " + d.getValueColumn() + " AS v, " + d.getLabelColumn() + " AS l"
                + " FROM " + d.getLookupTable()
                + (cascade ? " WHERE " + d.getFilterColumn() + " = ?" : "")
                + " ORDER BY 2 LIMIT 500";
        var mapper = (org.springframework.jdbc.core.RowMapper<ParamOptionDto>) (rs, i) ->
                new ParamOptionDto(rs.getString("v"), rs.getString("l"));
        return cascade ? jdbc.query(sql, mapper, parent) : jdbc.query(sql, mapper);
    }

    // ---- per-report assignment ------------------------------------------------

    public List<ParamDefDto> forReport(String reportCode) {
        List<ReportParam> rows = assignments.findByReportCodeOrderBySortOrderAsc(reportCode);
        if (rows.isEmpty()) return List.of();
        List<String> names = rows.stream().map(ReportParam::getParamName).toList();
        // per-report required overrides (HashMap so null values are allowed)
        java.util.Map<String, Boolean> overrideByName = new java.util.HashMap<>();
        for (ReportParam rp : rows) overrideByName.put(rp.getParamName(), rp.getRequiredOverride());
        // keep the assignment order
        var byName = defs.findByNameInOrderBySortOrderAsc(names).stream()
                .collect(java.util.stream.Collectors.toMap(ParamDef::getName, d -> d));
        return names.stream().map(byName::get).filter(java.util.Objects::nonNull)
                .map(d -> toDto(d, overrideByName.get(d.getName()))).toList();
    }

    @Transactional
    public List<ParamDefDto> assign(String reportCode, List<ReportParamAssignment> items) {
        for (ReportParamAssignment it : items) {
            if (!defs.existsByName(it.name())) throw new BadRequestException("Unknown parameter: " + it.name());
        }
        assignments.deleteByReportCode(reportCode);
        assignments.flush();
        int i = 0;
        for (ReportParamAssignment it : items) {
            ReportParam rp = new ReportParam();
            rp.setReportCode(reportCode);
            rp.setParamName(it.name());
            rp.setSortOrder(++i);
            rp.setRequiredOverride(it.requiredOverride());
            assignments.save(rp);
        }
        return forReport(reportCode);
    }

    /**
     * Enforce per-report required params at run time. Only params explicitly marked required for THIS
     * report (required_override = true, set on the register screen) are enforced; a report nobody has
     * configured (all overrides null) is never blocked, so existing runs never break retroactively.
     */
    public void validateRequired(String reportCode, java.util.Map<String, Object> params) {
        List<ParamDefDto> declared = forReport(reportCode);
        if (declared.isEmpty()) return;
        List<String> missing = new java.util.ArrayList<>();
        for (ParamDefDto p : declared) {
            if (Boolean.TRUE.equals(p.requiredOverride())) {
                Object v = params == null ? null : params.get(p.name());
                if (v == null || String.valueOf(v).isBlank()) missing.add(p.name());
            }
        }
        if (!missing.isEmpty()) {
            throw new BadRequestException("Missing required parameter(s): " + String.join(", ", missing));
        }
    }

    /** Default assignment for newly registered reports. */
    @Transactional
    public void assignDefaults(String reportCode) {
        assign(reportCode, java.util.stream.Stream.of("fiscalYear", "quarter", "regionCode", "branchCode")
                .map(n -> new ReportParamAssignment(n, null)).toList());
    }

    // ---- helpers ---------------------------------------------------------------

    private void validateLookup(String table, String value, String label, String filter) {
        if (table == null || !IDENT.matcher(table).matches() || DENY_TABLES.contains(table)) {
            throw new BadRequestException("Lookup table not allowed: " + table);
        }
        Integer found = jdbc.queryForObject(
                "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name=?",
                Integer.class, table);
        if (found == null || found == 0) {
            throw new BadRequestException("Lookup table not found in the internal warehouse: " + table);
        }
        for (String col : new String[]{value, label, filter}) {
            if (col != null && col.toLowerCase().contains("password")) {
                throw new BadRequestException("Column not allowed: " + col);
            }
        }
        for (String col : new String[]{value, label}) {
            if (col == null || !IDENT.matcher(col).matches()) {
                throw new BadRequestException("Invalid column identifier: " + col);
            }
        }
        if (filter != null && !filter.isBlank() && !IDENT.matcher(filter).matches()) {
            throw new BadRequestException("Invalid filter column: " + filter);
        }
    }

    /** SQL guard for query-sourced options: SELECT-only + no credential tables. */
    private static void validateLookupSql(String sql) {
        if (sql == null || sql.isBlank()) throw new BadRequestException("SQL is required for the sql source");
        DatasetService.validateSql(sql);
        String low = sql.toLowerCase();
        if (low.contains("app_user") || low.contains("db_password") || low.contains("password_hash")) {
            throw new BadRequestException("Lookup SQL must not reference credential tables/columns");
        }
    }

    private ParamDefDto toDto(ParamDef d) {
        return toDto(d, null);
    }

    private ParamDefDto toDto(ParamDef d, Boolean requiredOverride) {
        return new ParamDefDto(
                d.getId(), d.getName(), d.getLabel(), d.getType(), d.isRequired(),
                d.getDefaultValue(), d.getSourceType(),
                d.getOptionsJson() == null ? List.of() : readOptions(d.getOptionsJson()),
                d.getLookupTable(), d.getSourceSql(), d.getDatasourceId(),
                d.getValueColumn(), d.getLabelColumn(),
                d.getDependsOn(), d.getFilterColumn(), d.getSortOrder(),
                assignments.countByParamName(d.getName()), requiredOverride);
    }

    private List<ParamOptionDto> readOptions(String optionsJson) {
        try {
            return json.readValue(optionsJson, new TypeReference<List<ParamOptionDto>>() {});
        } catch (Exception e) {
            return List.of();
        }
    }

    private String writeJson(Object o) {
        try {
            return json.writeValueAsString(o);
        } catch (Exception e) {
            throw new BadRequestException("Options not serializable");
        }
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }
}
