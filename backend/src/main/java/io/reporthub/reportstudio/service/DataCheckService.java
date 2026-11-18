package io.reporthub.reportstudio.service;

import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.support.CronExpression;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.DataCheck;
import io.reporthub.reportstudio.domain.DataCheckRun;
import io.reporthub.reportstudio.repo.DataCheckRepository;
import io.reporthub.reportstudio.repo.DataCheckRunRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;

import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.stream.Collectors;
import java.util.Objects;
import java.util.Map;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Runs the data checks: programs that validate report data.
 *
 * <p>A check's SQL returns the rows that are wrong, so the verdict is just the row count: at or
 * below {@code maxRows} is a pass, above it is a fail, and anything that throws is an error —
 * kept distinct from a fail, because "the rule found problems" and "the rule could not be
 * evaluated" call for different actions.
 *
 * <p>The same {@code $YEAR4}/{@code $YEAR2} substitution as the warehouse pipelines, for the same
 * reason: one definition serves every fiscal year. The result rows are never stored — only counted
 * — so a check over sensitive data leaves nothing behind; the screen re-runs the query to show them.
 */
@Service
public class DataCheckService {

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(DataCheckService.class);

    private final DataCheckRepository repo;
    private final DataCheckRunRepository runs;
    private final DatasetService datasets;

    /**
     * Checks run on a worker, not on the request thread.
     *
     * <p>A reverse proxy may cut a synchronous request off (502), and a check over a
     * few million rows takes longer than that — so a check that runs long could never report its
     * own result to the browser, however correct it was. The run row is written as {@code running}
     * and the screen polls it, the same way pipeline runs already work.
     */
    private final ExecutorService pool =
            Executors.newSingleThreadExecutor(r -> new Thread(r, "data-check-run"));
    /**
     * Queries of the "Findings by record" tab may run concurrently; each check is an independent query on the target database.
     * Limited to 4 at once: the same database still serves other workloads, and firing all at once just moves the bottleneck there.
     */
    private final ExecutorService findingsPool =
            Executors.newFixedThreadPool(4, r -> new Thread(r, "check-findings"));

    public DataCheckService(DataCheckRepository repo, DataCheckRunRepository runs, DatasetService datasets,
                            io.reporthub.reportstudio.repo.CheckGroupScopeRepository scopes) {
        this.repo = repo;
        this.runs = runs;
        this.datasets = datasets;
        this.scopes = scopes;
    }

    private final io.reporthub.reportstudio.repo.CheckGroupScopeRepository scopes;

    // ─────────────────────────── User-defined group scope ($SCOPE) ───────────────────────────

    /** Stored scope of this group; empty = never set (falls back to inferring from members' SQL). */
    @Transactional(readOnly = true)
    public java.util.Optional<io.reporthub.reportstudio.domain.CheckGroupScope> scopeOf(String folder) {
        return scopes.findById(folder == null ? "" : folder.trim());
    }

    /** Stored shared conditions split into lines, with blank lines and surrounding whitespace dropped. */
    public static List<String> conditionsOf(io.reporthub.reportstudio.domain.CheckGroupScope sc) {
        if (sc == null || sc.getConditions() == null) return List.of();
        return java.util.Arrays.stream(sc.getConditions().split("\\R"))
                .map(String::trim).filter(x -> !x.isEmpty()).toList();
    }

    /**
     * The text {@code $SCOPE} is replaced with at run time; always a subquery.
     *
     * <p>A subquery rather than a bare table name for two reasons: the source may be a SELECT
     * (not only a table name), and the shared conditions must stay bound to the source instead of mixing
     * with the rule's WHERE, where an OR in the rule would immediately escape the scope.
     *
     * <p>No alias is added, so a rule written as {@code FROM $SCOPE t} can set its own alias.
     * Both Oracle and PostgreSQL accept a subquery after FROM without a mandatory alias in this form.
     */
    public static String scopeExpr(io.reporthub.reportstudio.domain.CheckGroupScope sc) {
        String src = sc.getSource() == null ? "" : sc.getSource().trim();
        while (src.endsWith(";")) src = src.substring(0, src.length() - 1).trim();
        // A bare table name (SCHEMA.TABLE) is used as is; anything else is a SELECT and must be wrapped in parentheses.
        String from = src.matches("(?i)[A-Za-z0-9_$#]+(\\.[A-Za-z0-9_$#]+)?") ? src : "(" + src + ")";
        List<String> conds = conditionsOf(sc);
        return "(SELECT * FROM " + from + (conds.isEmpty() ? "" : " WHERE " + String.join(" AND ", conds)) + ")";
    }

    @Transactional
    public void saveScope(io.reporthub.reportstudio.domain.CheckGroupScope sc) { scopes.save(sc); }

    /** Change only the rule's SQL text; no other field is touched (last run result and schedule must stay intact). */
    @Transactional
    public void replaceSql(Long id, String sql) {
        DataCheck c = require(id);
        c.setSqlText(sql);
        repo.save(c);
    }

    @Transactional
    public void deleteScope(String folder) { scopes.deleteById(folder == null ? "" : folder.trim()); }

    /**
     * Replace {@code $SCOPE} in a rule with the scope of the group the rule belongs to.
     *
     * <p>Rules not using {@code $SCOPE} are left untouched, so existing rules naming a table directly still work.
     * If a rule uses $SCOPE but its group has no scope, throw a readable message instead of letting
     *    the database report a syntax error on the leftover variable.
     */
    @Transactional(readOnly = true)
    public String applyScope(DataCheck c, String sql) {
        if (sql == null || !sql.contains("$SCOPE")) return sql;
        var sc = scopeOf(c.getFolder()).orElseThrow(() -> new BadRequestException(
                "This rule uses $SCOPE but group \"" + (c.getFolder() == null || c.getFolder().isBlank()
                        ? "(ungrouped)" : c.getFolder()) + "\" has no scope yet; set it in the Scope tab first"));
        return sql.replace("$SCOPE", scopeExpr(sc));
    }

    @Transactional(readOnly = true)
    public List<DataCheck> list() {
        return repo.findAllByOrderByCreatedAtDesc();
    }

    @Transactional(readOnly = true)
    public DataCheck require(Long id) {
        return repo.findById(id).orElseThrow(() -> new NotFoundException("Check not found: " + id));
    }

    @Transactional(readOnly = true)
    public List<DataCheckRun> history(Long id, int limit) {
        require(id);
        return runs.findByCheckIdOrderByStartedAtDesc(id, PageRequest.of(0, Math.min(Math.max(limit, 1), 200)));
    }

    @Transactional
    public DataCheck save(Long id, DataCheck form, String user) {
        validate(form);
        DataCheck c = id == null ? new DataCheck() : require(id);
        c.setName(form.getName().trim());
        c.setDescription(form.getDescription());
        c.setFolder(blank(form.getFolder()));
        c.setDatasourceId(blank(form.getDatasourceId()));
        c.setSqlText(form.getSqlText().trim());
        c.setFiscalYear(blank(form.getFiscalYear()));
        c.setMaxRows(Math.max(form.getMaxRows(), 0));
        c.setCron(blank(form.getCron()));
        c.setEnabled(form.isEnabled());
        OffsetDateTime now = OffsetDateTime.now();
        if (id == null) { c.setCreatedBy(user); c.setCreatedAt(now); }
        c.setUpdatedAt(now);
        c.setNextRunAt(c.isEnabled() && c.getCron() != null ? nextFrom(c.getCron(), now) : null);
        return repo.save(c);
    }

    @Transactional
    public DataCheck setEnabled(Long id, boolean enabled) {
        DataCheck c = require(id);
        c.setEnabled(enabled);
        c.setUpdatedAt(OffsetDateTime.now());
        c.setNextRunAt(enabled && c.getCron() != null ? nextFrom(c.getCron(), OffsetDateTime.now()) : null);
        return repo.save(c);
    }

    /**
     * Move a check to another group; blank/null = remove from the group.
     *
     * <p>A dedicated method rather than save(), because save overwrites the whole check
     * (name, SQL, year, row limit), so dragging a check into a group could overwrite SQL someone just edited.
     */
    @Transactional
    public DataCheck setFolder(Long id, String folder) {
        DataCheck c = require(id);
        String f = folder == null ? null : folder.trim();
        c.setFolder(f == null || f.isEmpty() ? null : f);
        return repo.save(c);
    }

    /**
     * Rename a whole group; every check in the old group moves to the new name at once.
     *
     * <p>A group has no table of its own; it is just the group name typed on its checks, so renaming
     * = updating every check in it. Doing it one by one from the UI would briefly split the group in two.
     *
     * @return number of checks moved
     */
    @Transactional
    public int renameFolder(String from, String to) {
        String src = from == null ? "" : from.trim();
        String dst = to == null ? null : to.trim();
        if (src.isEmpty()) throw new IllegalArgumentException("The source group is required");
        List<DataCheck> members = repo.findAll().stream()
                .filter(c -> src.equals(c.getFolder() == null ? "" : c.getFolder().trim()))
                .toList();
        for (DataCheck c : members) c.setFolder(dst == null || dst.isEmpty() ? null : dst);
        repo.saveAll(members);
        return members.size();
    }

    @Transactional
    public void delete(Long id) {
        DataCheck c = require(id);
        runs.deleteByCheckId(id);
        repo.delete(c);
    }

    /** @param year overrides the check's own year (the portal's current year when run by hand). */
    @Transactional
    public DataCheckRun runNow(Long id, String user, String year) {
        return runNow(id, user, year, null);
    }

    /** @param batchId round id when the whole group is run together; null = single run */
    @Transactional
    public DataCheckRun runNow(Long id, String user, String year, String batchId) {
        DataCheck c = require(id);
        final String y = year == null || year.isBlank() ? c.getFiscalYear() : year.trim();

        DataCheckRun run = new DataCheckRun();
        run.setCheckId(c.getId());
        run.setStartedAt(OffsetDateTime.now());
        run.setTrigger("manual");
        run.setRunBy(user);
        run.setStatus("running");
        run.setBatchId(batchId);
        final DataCheckRun saved = runs.save(run);

        c.setLastStatus("running");
        c.setLastError(null);
        c.setLastRunAt(saved.getStartedAt());
        repo.save(c);

        // Hand off only after commit — the worker loads the rows by id and would not see them yet.
        final Long checkId = c.getId();
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { pool.submit(() -> work(saved.getId(), checkId, y)); }
        });
        return saved;
    }

    /**
     * Runs the check on the worker thread and fills in the run row that {@code runNow} left open.
     *
     * <p>No {@code @Transactional} here on purpose: this is called from the pool, not through the
     * Spring proxy, so the annotation would be inert and only misleading. Each save is its own
     * transaction, which is what a long-running job wants anyway.
     */
    private void work(Long runId, Long checkId, String year) {
        DataCheck c = repo.findById(checkId).orElse(null);
        DataCheckRun run = runs.findById(runId).orElse(null);
        if (c == null || run == null) return;
        fill(c, run, year);
        persistRunResult(c, run);
    }

    /**
     * Never save the whole (stale) entity: a check deleted or edited while this ran must stay as the user
     * left it. Only the run-result columns are written; a deleted check drops the run instead of reappearing.
     */
    void persistRunResult(DataCheck c, DataCheckRun run) {
        if (repo.saveRunResult(c.getId(), c.getLastStatus(), c.getLastCount(), c.getLastError()) == 0) {
            runs.delete(run);
            return;
        }
        runs.save(run);
    }

    /**
     * Run a check on the caller's thread and return when done; for chains that need the result before
     * moving to the next step.
     *
     * <p>Chains used to call {@link #runNow}, which now runs in the background (a reverse proxy may time it out) and
     * returns a running row immediately, so a chain's check step read the result before the check finished and
     * always saw "fail"; a gate that never opens makes the chain unusable.
     */
    @Transactional
    public DataCheckRun runInline(Long id, String user, String year) {
        DataCheck c = require(id);
        String y = year == null || year.isBlank() ? c.getFiscalYear() : year.trim();
        return execute(c, "chain", user, y);
    }

    /**
     * Run several checks with one request; returns as soon as all are queued, without waiting for results.
     *
     * <p>Why server-side when the UI could loop over {@link #runNow} itself: if the UI loops
     * and the user closes the tab midway, the remaining checks never run and half the group is left
     * silently unrun. One request guarantees that "submitted = all queued".
     *
     * <p>Work still runs one at a time on the existing single-thread pool in queue order. The slowest
     * check takes ~96 s and 20 checks ~260 s, far beyond the 30 s edge timeout,
     * so this must never wait for results.
     *
     * <p>Skips checks already running, otherwise a double click would create overlapping rounds of the same check.
     *
     * @param ids    explicit ids (empty = use folder instead)
     * @param folder whole group, used when ids is empty; null/blank = ungrouped checks
     * @return queued run rows, in the order requested
     */
    @Transactional
    public List<DataCheckRun> runBatch(List<Long> ids, String folder, String user, String year) {
        List<DataCheck> targets;
        if (ids != null && !ids.isEmpty()) {
            // Order results by the ids sent, not database order: the UI order is what the user intended.
            Map<Long, DataCheck> byId = repo.findAllById(ids).stream()
                    .collect(Collectors.toMap(DataCheck::getId, c -> c));
            targets = ids.stream().map(byId::get).filter(Objects::nonNull).toList();
        } else {
            String f = folder == null || folder.isBlank() ? null : folder.trim();
            targets = repo.findAll().stream()
                    .filter(c -> f == null ? (c.getFolder() == null || c.getFolder().isBlank())
                                           : f.equals(c.getFolder()))
                    .toList();
        }

        // One submission = one round; every check in it shares the id, so the UI can show "what this round found".
        String batchId = java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 24);
        List<DataCheckRun> queued = new ArrayList<>();
        for (DataCheck c : targets) {
            if (!c.isEnabled()) continue;                     // paused checks are not run
            if ("running".equals(c.getLastStatus())) continue; // avoid overlapping rounds from double clicks
            // The check's own fiscal year must always win over the year sent with the request.
            //
            // runNow treats the year passed in as an override, not a fallback (see its javadoc).
            // Passing the portal year to every check would run checks pinned to their own year with the wrong one;
            // the SQL would find 0 rows because that year has no data yet, and record a green "pass" that never
            // really checked anything. This must match yearFor() used by single runs in the UI:
            // the check's own year first, then the portal year.
            String own = c.getFiscalYear();
            queued.add(runNow(c.getId(), user, own != null && !own.isBlank() ? own.trim() : year, batchId));
        }
        return queued;
    }

    // ---- Per-group views: source, check rounds ------------------------------------

    /** All checks in a group; blank/null folder = ungrouped. */
    @Transactional(readOnly = true)
    public List<DataCheck> inFolder(String folder) {
        String f = folder == null || folder.isBlank() ? null : folder.trim();
        return repo.findAll().stream()
                .filter(c -> f == null ? (c.getFolder() == null || c.getFolder().isBlank())
                                       : f.equals(c.getFolder() == null ? null : c.getFolder().trim()))
                .sorted(java.util.Comparator.comparing(DataCheck::getName,
                        java.util.Comparator.nullsLast(String::compareToIgnoreCase)))
                .toList();
    }

    /**
     * Source table read by the rules in a group: taken from each query's FROM clause, picking the most used one.
     *
     * <p>A group usually checks the same dataset throughout (e.g. 18 of 19 checks in a pre-export group
     * read the same staging table), so the UI can tell which data is being checked without manual linking.
     */
    public static String sourceTableOf(List<DataCheck> checks) {
        java.util.regex.Pattern p = java.util.regex.Pattern.compile(
                "(?is)\\bFROM\\s+([A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)?)");
        Map<String, Integer> tally = new java.util.LinkedHashMap<>();
        for (DataCheck c : checks) {
            String sql = c.getSqlText();
            if (sql == null) continue;
            java.util.regex.Matcher m = p.matcher(sql);
            if (m.find()) {
                String t = m.group(1).toUpperCase();
                tally.merge(t, 1, Integer::sum);
            }
        }
        return tally.entrySet().stream()
                .max(Map.Entry.comparingByValue())
                .map(Map.Entry::getKey)
                .orElse(null);
    }

    /**
     * Conditions shared by every check in the group, i.e. the scope of the data being checked.
     *
     * <p>Rules in a group usually start with the same WHERE and then add their own conditions
     * (e.g. every check in a group starts with the same YEAR / REGION conditions),
     * so the shared part tells which slice of the data is being checked.
     *
     * <p>Only simple {@code column = value} terms are taken; complex terms (nested parentheses, OR)
     * are check-specific conditions, not shared scope.
     */
    public static List<String> commonWhere(List<DataCheck> checks) {
        java.util.regex.Pattern where = java.util.regex.Pattern.compile("(?is)\\bWHERE\\b(.*)");
        java.util.regex.Pattern simple = java.util.regex.Pattern.compile(
                "(?i)^[A-Za-z0-9_.]+\\s*(=|IS\\s+NOT\\s+NULL|IS\\s+NULL)\\s*'?[^']*'?$");
        List<java.util.Set<String>> perCheck = new ArrayList<>();
        for (DataCheck c : checks) {
            String sql = c.getSqlText();
            if (sql == null) continue;
            java.util.regex.Matcher m = where.matcher(sql);
            if (!m.find()) continue;
            java.util.Set<String> terms = new java.util.LinkedHashSet<>();
            for (String raw : m.group(1).split("(?i)\\bAND\\b")) {
                String t = raw.trim().replaceAll("\\s+", " ");
                // Cut the tail where check-specific conditions begin (open parenthesis / ORDER BY / GROUP BY).
                int cut = t.indexOf('(');
                if (cut == 0) continue;
                if (cut > 0) t = t.substring(0, cut).trim();
                t = t.replaceAll("(?is)\\b(ORDER|GROUP)\\s+BY\\b.*$", "").trim();
                if (t.isEmpty() || !simple.matcher(t).matches()) continue;
                terms.add(t);
            }
            if (!terms.isEmpty()) perCheck.add(terms);
        }
        if (perCheck.isEmpty()) return List.of();
        // Requiring "every check has it" does not work: a group often has 2-3 summary checks
        //    (e.g. "dataset must not be empty" using COUNT/HAVING) without the shared WHERE,
        //    which would always yield nothing. Use "most checks use it" instead and show the count in the UI.
        int need = Math.max(2, (int) Math.ceil(perCheck.size() * 0.6));
        Map<String, Integer> tally = new java.util.LinkedHashMap<>();
        for (java.util.Set<String> t : perCheck) for (String term : t) tally.merge(term, 1, Integer::sum);
        return tally.entrySet().stream()
                .filter(e -> e.getValue() >= need)
                .map(Map.Entry::getKey)
                .toList();
    }

    /**
     * Row count in the checked scope, counted on the source table with the group's shared conditions.
     *
     * <p>Counted live each time the tab opens, not stored, since pipelines change the source data at any time.
     * Returns null when there is no table/condition or the query fails; this figure is informational, not a check result.
     */
    @Transactional(readOnly = true)
    public Long scopeRows(List<DataCheck> members, String table, List<String> where, String year) {
        if (table == null || members.isEmpty()) return null;
        DataCheck first = members.get(0);
        String y = year == null || year.isBlank() ? first.getFiscalYear() : year.trim();
        String sql = "SELECT COUNT(*) AS N FROM " + table
                + (where.isEmpty() ? "" : " WHERE " + String.join(" AND ", where));
        try {
            DatasetService.TableResult r = datasets.preview(first.getDatasourceId(),
                    WarehouseService.resolveYear(sql, y), 1);
            if (r.rows().isEmpty() || r.rows().get(0).isEmpty()) return null;
            Object v = r.rows().get(0).get(0);
            return v == null ? null : Long.valueOf(v.toString().replaceAll("[^0-9-]", ""));
        } catch (Exception e) {
            log.warn("Could not count rows in the group scope: {}", e.toString());
            return null;
        }
    }

    /** Cap on failing rows stored with one run. */
    private static final int FINDING_ROWS = 500;

    /**
     * Fetch this check's failing rows and store them as JSON; called when a run finishes with a fail.
     *
     * <p>Returns null on failure: storing this extra must never turn an obtained check result into an error.
     */
    private String captureFindings(DataCheck c, String resolvedSql, int count) {
        try {
            DatasetService.TableResult r = datasets.preview(c.getDatasourceId(), resolvedSql, FINDING_ROWS);
            Map<String, Object> box = new java.util.LinkedHashMap<>();
            box.put("columns", r.columns());
            box.put("rows", r.rows());
            box.put("capped", count > FINDING_ROWS);
            return new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(box);
        } catch (Exception e) {
            log.warn("Could not store failing rows of '{}': {}", c.getName(), e.toString());
            return null;
        }
    }

    /** Parse stored JSON back into a table; null = nothing stored (older run / passing check / bad JSON). */
    static DatasetService.TableResult readFindings(String json) {
        if (json == null || json.isBlank()) return null;
        try {
            var n = new com.fasterxml.jackson.databind.ObjectMapper().readTree(json);
            List<String> cols = new ArrayList<>();
            n.get("columns").forEach(x -> cols.add(x.asText()));
            List<List<Object>> rows = new ArrayList<>();
            n.get("rows").forEach(r -> {
                List<Object> row = new ArrayList<>();
                r.forEach(v -> row.add(v.isNull() ? null : (v.isNumber() ? v.numberValue() : v.asText())));
                rows.add(row);
            });
            return new DatasetService.TableResult(cols, rows, rows.size());
        } catch (Exception e) {
            return null;
        }
    }

    /** One record that fails rules: how many and which checks, with context values for follow-up. */
    public record Finding(String key, List<String> rules, Map<String, Object> columns) {}

    /**
     * Findings "by record": all failing checks combined and grouped by failing record.
     *
     * <p>The rule view only answers "which check fails and how many rows", but whoever fixes the data
     * asks the other way round: "what is wrong with this record". One record can fail several checks.
     *
     * <p>Only checks whose latest result failed are run; passing checks return 0 rows anyway
     * (a group of 19 checks over a table of 2.4M rows would take minutes to run in full).
     *
     * @param keyColumn column identifying a record; blank = picked from columns every check returns
     * @param perRule   row cap per check
     */
    /**
     * Findings by record for a specific round, read from the failing rows stored at run time; no new queries.
     *
     * <p>Older rounds without stored rows return empty: that data was never stored and
     * cannot be rebuilt because the source has changed since; re-running would pass off today's result
     * as that round's, which is worse than having no data.
     */
    @Transactional(readOnly = true)
    public List<Finding> findingsOfRuns(List<DataCheckRun> runsOfRound, Map<Long, String> checkNames, String keyColumn) {
        Map<DataCheck, DatasetService.TableResult> results = new java.util.LinkedHashMap<>();
        Map<String, DatasetService.TableResult> byName = new java.util.LinkedHashMap<>();
        for (DataCheckRun r : runsOfRound) {
            if (!"fail".equals(r.getStatus())) continue;
            DatasetService.TableResult t = readFindings(r.getFindings());
            if (t != null) byName.put(checkNames.getOrDefault(r.getCheckId(), "#" + r.getCheckId()), t);
        }
        if (byName.isEmpty()) return List.of();
        return merge(byName, keyColumn);
    }

    @Transactional(readOnly = true)
    public List<Finding> findings(String folder, String keyColumn, String year, int perRule) {
        List<DataCheck> failing = inFolder(folder).stream()
                .filter(c -> "fail".equals(c.getLastStatus()))
                .toList();
        if (failing.isEmpty()) return List.of();

        // The latest result of each check already has its failing rows stored from run time, so use them.
        //    Only checks with nothing stored (older runs) are queried.
        Map<String, DatasetService.TableResult> stored = new java.util.LinkedHashMap<>();
        List<DataCheck> needQuery = new ArrayList<>();
        for (DataCheck c : failing) {
            DatasetService.TableResult t = runs.findFirstByCheckIdOrderByStartedAtDesc(c.getId())
                    .map(r -> readFindings(r.getFindings())).orElse(null);
            if (t != null) stored.put(c.getName(), t); else needQuery.add(c);
        }
        if (needQuery.isEmpty()) return merge(stored, keyColumn);
        failing = needQuery;

        // Collect each check's result first, then find the shared key: it must be a column every check returns.
        //
        // Running checks sequentially made total time the sum of all checks:
        //    3 failing checks over a 2.4M-row table took ~18 s before the view appeared.
        //    Each check is an independent query, so there is no need to wait.
        // So run them concurrently; total time becomes that of the slowest check.
        //
        // Read the group scope (for $SCOPE) before forking threads; worker threads must not touch
        //    the JPA repository, since this transaction's session is bound to the main thread only.
        final var scope = scopeOf(folder).orElse(null);
        final String y = year == null || year.isBlank() ? null : year.trim();
        Map<DataCheck, DatasetService.TableResult> results = new java.util.LinkedHashMap<>();
        var futures = new java.util.LinkedHashMap<DataCheck, java.util.concurrent.Future<DatasetService.TableResult>>();
        for (DataCheck c : failing) {
            final String rawSql = c.getSqlText();
            final String dsId = c.getDatasourceId();
            final String yy = y == null ? c.getFiscalYear() : y;
            futures.put(c, findingsPool.submit(() -> {
                String sql = rawSql;
                if (sql != null && sql.contains("$SCOPE")) {
                    if (scope == null) throw new BadRequestException("Rule uses $SCOPE but the group has no scope yet");
                    sql = sql.replace("$SCOPE", scopeExpr(scope));
                }
                return datasets.preview(dsId, WarehouseService.resolveYear(sql, yy),
                        Math.min(Math.max(perRule, 1), 500));
            }));
        }
        for (var e : futures.entrySet()) {
            try {
                results.put(e.getKey(), e.getValue().get());
            } catch (Exception ex) {
                log.warn("Could not fetch failing rows of '{}': {}", e.getKey().getName(), ex.toString());
            }
        }
        if (results.isEmpty()) return List.of();

        Map<String, DatasetService.TableResult> all = new java.util.LinkedHashMap<>(stored);
        for (var e : results.entrySet()) all.put(e.getKey().getName(), e.getValue());
        return merge(all, keyColumn);
    }

    /** Merge results of several checks into per-record findings; shared by the stored and live paths. */
    private List<Finding> merge(Map<String, DatasetService.TableResult> results, String keyColumn) {
        if (results.isEmpty()) return List.of();
        String key = keyColumn == null || keyColumn.isBlank() ? guessKey(results.values()) : keyColumn.trim();
        // No column shared by every check: key each check's rows by its own first column rather than
        // showing nothing, so failing records are still listed (they just are not merged across checks).
        final boolean perCheckKey = key == null;

        Map<String, Finding> byKey = new java.util.LinkedHashMap<>();
        for (var e : results.entrySet()) {
            DatasetService.TableResult t = e.getValue();
            int ki = perCheckKey ? (t.columns().isEmpty() ? -1 : 0) : indexOfIgnoreCase(t.columns(), key);
            if (ki < 0) continue;                       // this check does not return the key column, skip it
            for (List<Object> row : t.rows()) {
                Object kv = ki < row.size() ? row.get(ki) : null;
                if (kv == null) continue;
                String k = kv.toString();
                if (perCheckKey) {                      // each row is its own record: keep same-valued rows apart
                    String base = k;
                    for (int n = 2; byKey.containsKey(k); n++) k = base + " (" + n + ")";
                }
                Finding f = byKey.get(k);
                if (f == null) {
                    f = new Finding(k, new ArrayList<>(), new java.util.LinkedHashMap<>());
                    byKey.put(k, f);
                }
                // Merge columns from every check the record fails, not just the first one found.
                //    Each check SELECTs different columns, and taking only the first check's set
                //    left records failing 2 checks with half their values,
                //    so exported files had empty columns even though the data existed.
                for (int i = 0; i < t.columns().size() && i < row.size(); i++) {
                    Object v = row.get(i);
                    // Later values do not overwrite earlier ones, only fill empty cells; the first check found wins.
                    if (v != null && f.columns().get(t.columns().get(i)) == null) {
                        f.columns().put(t.columns().get(i), v);
                    } else {
                        f.columns().putIfAbsent(t.columns().get(i), v);
                    }
                }
                if (!f.rules().contains(e.getKey())) f.rules().add(e.getKey());
            }
        }
        // Records failing more checks first: those are the ones to fix first.
        return byKey.values().stream()
                .sorted((a, b) -> Integer.compare(b.rules().size(), a.rules().size()))
                .toList();
    }

    /** Columns every check returns; the first one (in the first check's column order) is the record key. Never chosen by name. */
    private static String guessKey(java.util.Collection<DatasetService.TableResult> results) {
        List<String> common = null;
        for (DatasetService.TableResult t : results) {
            List<String> cols = t.columns().stream().map(String::toUpperCase).toList();
            common = common == null ? new ArrayList<>(cols)
                    : common.stream().filter(cols::contains).collect(Collectors.toCollection(ArrayList::new));
        }
        if (common == null || common.isEmpty()) return null;
        return common.get(0);
    }

    private static int indexOfIgnoreCase(List<String> cols, String name) {
        for (int i = 0; i < cols.size(); i++) if (cols.get(i).equalsIgnoreCase(name)) return i;
        return -1;
    }

    @Transactional
    public int runDue() {
        OffsetDateTime now = OffsetDateTime.now();
        List<DataCheck> due = repo.findByEnabledTrueAndCronIsNotNullAndNextRunAtLessThanEqual(now);
        for (DataCheck c : due) {
            c.setNextRunAt(nextFrom(c.getCron(), now));   // advance first so a slow check can't double-fire
            repo.save(c);
            io.reporthub.reportstudio.tenancy.TenantContext.runAs(io.reporthub.reportstudio.tenancy.TenantContext.of(c.getTenantId(), c.getProjectId()),
                    () -> execute(c, "scheduled", "scheduler", c.getFiscalYear()));
        }
        return due.size();
    }

    /** The offending rows themselves, for the "view failing rows" panel. Re-runs the query. */
    @Transactional(readOnly = true)
    public DatasetService.TableResult offendingRows(Long id, String year, int limit) {
        DataCheck c = require(id);
        String y = year == null || year.isBlank() ? c.getFiscalYear() : year.trim();
        return datasets.preview(c.getDatasourceId(),
                WarehouseService.resolveYear(applyScope(c, c.getSqlText()), y),
                Math.min(Math.max(limit, 1), 500));
    }

    private DataCheckRun execute(DataCheck c, String trigger, String user, String year) {
        DataCheckRun run = new DataCheckRun();
        run.setCheckId(c.getId());
        run.setStartedAt(OffsetDateTime.now());
        run.setTrigger(trigger);
        run.setRunBy(user);
        fill(c, run, year);
        // Do not repo.save(c) here: c was read before running SQL that takes seconds.
        //    If someone edits this check in the UI meanwhile, saving the whole entity would silently overwrite it.
        //    So touch only the fields the run owns.
        c.setLastRunAt(run.getStartedAt());
        repo.touchLastRun(c.getId(), run.getStartedAt());
        return runs.save(run);
    }

    /** The verdict itself — shared by the manual (worker) path and the scheduled one. */
    private void fill(DataCheck c, DataCheckRun run, String year) {
        try {
            String sql = WarehouseService.resolveYear(applyScope(c, c.getSqlText()), year);
            // count in the database — a check that finds 200k bad rows must not drag them all back
            DatasetService.TableResult r = datasets.preview(c.getDatasourceId(),
                    "SELECT COUNT(*) AS BAD_ROWS FROM (" + sql + ") chk_q", 1);
            int count = toInt(r);
            boolean pass = count <= c.getMaxRows();
            run.setStatus(pass ? "pass" : "fail");
            run.setRowCount(count);
            // On fail, store the failing rows with this run while the query is still warm,
            //    so the Findings view reads stored rows instead of re-querying each time it opens,
            //    and failing rows of older rounds can be reviewed.
            //    Row-capped: one check can fail on hundreds of thousands of rows, which would bloat the database.
            if (!pass && count > 0) run.setFindings(captureFindings(c, sql, count));
            run.setMessage((year != null && !year.isBlank() ? "Year " + year + " · " : "")
                    + (pass ? "Pass · found " + count + " rows (allowed " + c.getMaxRows() + ")"
                            : "Fail · found " + count + " rows, more than allowed " + c.getMaxRows()));
            c.setLastStatus(pass ? "pass" : "fail");
            c.setLastCount(count);
            c.setLastError(null);
        } catch (Exception e) {
            String msg = WarehouseService.friendly(rootMessage(e));
            run.setStatus("error");
            run.setMessage(msg);
            c.setLastStatus("error");
            c.setLastError(msg);
        }
        run.setFinishedAt(OffsetDateTime.now());
    }

    private static int toInt(DatasetService.TableResult r) {
        if (r.rows().isEmpty() || r.rows().get(0).isEmpty()) return 0;
        Object v = r.rows().get(0).get(0);
        return v instanceof Number n ? n.intValue() : Integer.parseInt(String.valueOf(v));
    }

    private static void validate(DataCheck f) {
        if (f.getName() == null || f.getName().isBlank()) throw new BadRequestException("Name is required");
        if (f.getSqlText() == null || f.getSqlText().isBlank()) throw new BadRequestException("SQL is required");
        DatasetService.validateSql(f.getSqlText());
        String fy = f.getFiscalYear() == null ? "" : f.getFiscalYear().trim();
        if (!fy.isEmpty() && !fy.matches("\\d{4}")) {
            throw new BadRequestException("Fiscal year must be a 4-digit number, e.g. 2026");
        }
        if (f.getCron() != null && !f.getCron().isBlank()) {
            try { io.reporthub.reportstudio.util.Cron.parse(f.getCron()); }
            catch (IllegalArgumentException e) { throw new BadRequestException("Invalid cron: " + e.getMessage()); }
            // a timer has no UI to read the year from
            if (fy.isEmpty() && f.getSqlText().matches("(?s).*\\$YEAR.*")) {
                throw new BadRequestException("SQL uses $YEAR4/$YEAR2; a scheduled check must specify the fiscal year");
            }
        }
    }

    private static OffsetDateTime nextFrom(String cron, OffsetDateTime from) {
        ZonedDateTime next = io.reporthub.reportstudio.util.Cron.parse(cron).next(from.toZonedDateTime());
        return next == null ? null : next.toOffsetDateTime();
    }

    private static String blank(String s) { return (s == null || s.isBlank()) ? null : s.trim(); }

    private static String rootMessage(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null && t.getCause() != t) t = t.getCause();
        return t.getMessage() == null ? t.toString() : t.getMessage();
    }
}
