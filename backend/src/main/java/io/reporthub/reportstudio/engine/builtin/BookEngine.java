package io.reporthub.reportstudio.engine.builtin;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import io.reporthub.reportstudio.domain.Report;
import io.reporthub.reportstudio.domain.ReportUnit;
import io.reporthub.reportstudio.domain.ReportUnitFile;
import io.reporthub.reportstudio.engine.EngineConfig;
import io.reporthub.reportstudio.engine.EngineProp;
import io.reporthub.reportstudio.engine.EngineRegistry;
import io.reporthub.reportstudio.engine.EngineResolver;
import io.reporthub.reportstudio.engine.ReportEngine;
import io.reporthub.reportstudio.render.PdfBook;
import io.reporthub.reportstudio.render.RenderException;
import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;
import io.reporthub.reportstudio.render.JobCancelRegistry;
import io.reporthub.reportstudio.repo.DatasourceRepository;
import io.reporthub.reportstudio.repo.ReportRepository;
import io.reporthub.reportstudio.repo.ReportUnitFileRepository;
import io.reporthub.reportstudio.repo.ReportUnitRepository;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * "Book" engine - renders an existing report repeatedly, once per item, then joins the results into one PDF with a table of contents.
 *
 * <p>Some reports can only be produced for one branch at a time, while what has to be delivered is a "book" covering
 * every branch, grouped, with a TOC carrying real page numbers. Instead of hundreds of REST calls and merging files
 * by hand, this engine does it in one click and can be reused for any other report without new code.
 *
 * <h3>Configuration in the render unit's configJson</h3>
 * <pre>{@code
 * {
 *   "childReport":       "BRANCH-SUMMARY",     // report code to re-render (must differ from the book report)
 *   "loopSql":           "SELECT ... :<param> ...",  // 1 row = 1 item in the book
 *   "dropLeadingPages":  "2",                  // how many cover/TOC pages to drop from each child
 *   "childConcurrency":  "3",
 *   "tocTitle":          "Contents",
 *   "onChildError":      "fail",               // fail (default) | skip
 *   "maxItems":          "1000"
 * }
 * }</pre>
 *
 * <p><b>loopSql columns</b> - every column becomes a parameter of the child report (upper-case column name),
 * except two reserved names: {@code BOOK_LABEL} (TOC text) and {@code BOOK_GROUP} (TOC group heading).
 * Parameters the user enters at run time are passed to every child; loopSql columns may override them.
 * loopSql references run parameters as {@code :name} (real binds, not string concatenation).
 *
 * <h3>Deliberately avoided traps (do not rework without reading)</h3>
 * <ul>
 *   <li><b>Never use a key named {@code sql}</b> in configJson - {@code RenderWorker.sqlFromConfig()}
 *       extracts that key and injects it as the request's {@code sqlStatement} for every engine</li>
 *   <li><b>Call children through {@link EngineRegistry} directly, not {@link EngineResolver}</b> -
 *       the resolver is {@code @Transactional(readOnly=true)}; calling it per child hundreds of times (in parallel)
 *       opens a transaction and borrows a connection from a small shared connection pool, stalling every other report</li>
 *   <li><b>Resolve the child's template/datasource before fan-out</b> - child threads must not touch JPA</li>
 *   <li><b>Copy the MDC to child threads</b>, otherwise child logs are lost and job cancellation does not reach child connections</li>
 *   <li>A branch with no data yields only a cover - it must be dropped before joining, or a child cover lands mid-book</li>
 *   <li>The child must be a <b>different report</b> from the book report - if the book unit were attached to the same report,
 *       every single-branch export would build the whole book as well</li>
 * </ul>
 */
@Component
public class BookEngine implements ReportEngine {

    private static final Logger log = LoggerFactory.getLogger(BookEngine.class);

    public static final String KIND = "book";

    /** Reserved loopSql column names - used for the TOC, not passed to children as parameters */
    private static final String COL_LABEL = "BOOK_LABEL";
    private static final String COL_GROUP = "BOOK_GROUP";

    private final ObjectProvider<EngineRegistry> registryProvider;
    private final ObjectProvider<EngineResolver> resolverProvider;
    private final ReportRepository reports;
    private final ReportUnitRepository units;
    private final ReportUnitFileRepository unitFiles;
    private final DatasourceRepository datasources;
    private final BookProgress progress;
    private final JobCancelRegistry cancelRegistry;
    private final ObjectMapper mapper;

    /**
     * {@code ObjectProvider} is not decoration - BookEngine is itself a {@code ReportEngine} bean
     * that {@link EngineRegistry} needs while being constructed; injecting the registry/resolver directly creates
     * a dependency cycle (BookEngine -> EngineRegistry -> List&lt;ReportEngine&gt; -> BookEngine) and the app fails to boot
     */
    public BookEngine(ObjectProvider<EngineRegistry> registryProvider,
                      ObjectProvider<EngineResolver> resolverProvider,
                      ReportRepository reports,
                      ReportUnitRepository units,
                      ReportUnitFileRepository unitFiles,
                      DatasourceRepository datasources,
                      BookProgress progress,
                      JobCancelRegistry cancelRegistry,
                      ObjectMapper mapper) {
        this.registryProvider = registryProvider;
        this.resolverProvider = resolverProvider;
        this.reports = reports;
        this.units = units;
        this.unitFiles = unitFiles;
        this.datasources = datasources;
        this.progress = progress;
        this.cancelRegistry = cancelRegistry;
        this.mapper = mapper;
    }

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public String label() {
        return "Book (merged)";
    }

    @Override
    public List<EngineProp> reportProps() {
        return List.of(
                EngineProp.report("childReport", "Child report to render per item (report code)", "text", true,
                        "BRANCH-SUMMARY"),
                EngineProp.report("loopSql", "SQL book items - 1 row = 1 item", "sql", true,
                        "SELECT <item_column>, <label_column> AS BOOK_LABEL, <group_column> AS BOOK_GROUP FROM ... WHERE <column> = :<param> ORDER BY ..."),
                EngineProp.report("dropLeadingPages", "Leading child pages to drop (cover/TOC)", "number", false, "2"),
                EngineProp.report("childConcurrency", "Children rendered concurrently", "number", false, "3"),
                EngineProp.report("coverPages", "Book cover = first N pages of the first child (0 = no cover)",
                        "number", false, "0"),
                EngineProp.report("tocTitle", "TOC title (empty = no TOC)", "text", false, "Contents"),
                EngineProp.report("onChildError", "When a child fails: fail | skip", "text", false, "fail"),
                EngineProp.report("maxItems", "Max items (guards against a runaway query)", "number", false, "1000"),
                EngineProp.report("loopTimeoutSeconds", "loopSql time limit (seconds)", "number", false, "120")
        );
    }

    // ───────────────────────────────────────────────────────────── render

    @Override
    public RenderResult render(RenderRequest req, EngineConfig cfg) {
        String fmt = req.format() == null ? "pdf" : req.format().toLowerCase();
        if (!"pdf".equals(fmt)) {
            throw new RenderException("engine 'book' can only produce PDF - requested format: " + req.format());
        }
        JsonNode conf = readConfig(req.configJson());

        String childCode = text(conf, "childReport", null);
        String loopSql = text(conf, "loopSql", null);
        if (childCode == null || loopSql == null) {
            throw new RenderException("engine 'book' requires childReport and loopSql in the output config");
        }
        if (childCode.equalsIgnoreCase(req.code())) {
            throw new RenderException("childReport must be a different report from the book report (" + req.code() + ")");
        }
        int drop = number(conf, "dropLeadingPages", 0);
        // Every child's cover is dropped (otherwise it would repeat once per child), so the book
        // has no cover of its own; this takes the first child's cover and places it before the TOC.
        int coverPages = Math.max(0, number(conf, "coverPages", 0));
        int parallel = Math.max(1, Math.min(8, number(conf, "childConcurrency", 3)));
        int maxItems = Math.max(1, number(conf, "maxItems", 1000));
        int loopTimeout = Math.max(0, number(conf, "loopTimeoutSeconds", 120));
        String tocTitle = text(conf, "tocTitle", null);
        boolean skipBroken = "skip".equalsIgnoreCase(text(conf, "onChildError", "fail"));

        // ── Resolve everything that touches the database on this thread before spawning child threads
        List<Map<String, Object>> rows = loadRows(loopSql, req.params(), cfg, maxItems, loopTimeout);
        if (rows.isEmpty()) {
            throw new RenderException("loopSql returned no rows - nothing to build a book from");
        }
        ChildSpec spec = resolveChild(childCode, req);
        log.info("Book {}: child {} · {} items · drop leading {} · concurrency {}",
                req.code(), childCode, rows.size(), drop, parallel);

        String jobId = MDC.get("jobId");
        Path work = null;
        try {
            work = Files.createTempDirectory("rs-book-");
            List<Path> parts = renderChildren(spec, rows, work, parallel, skipBroken, jobId,
                    req.params() == null ? Map.of() : req.params());
            return assemble(rows, parts, drop, coverPages, tocTitle, work, req);
        } catch (RenderException e) {
            throw e;
        } catch (Exception e) {
            throw new RenderException("Book assembly failed: " + e, e);
        } finally {
            PdfBook.deleteDirQuietly(work);
        }
    }

    // ───────────────────────────────────────────── Book items (loopSql)

    /**
     * Runs loopSql on the book unit's datasource using its own connection (not borrowed from the app's Hikari pool,
     * which has only 10 connections in use by other renders). {@code :name} becomes a real bind parameter.
     */
    private List<Map<String, Object>> loadRows(String sql, Map<String, Object> params,
                                               EngineConfig cfg, int maxItems, int timeoutSeconds) {
        if (cfg == null || cfg.dsJdbcUrl() == null || cfg.dsJdbcUrl().isBlank()) {
            throw new RenderException("output of a book must have a datasource set (loopSql needs somewhere to run)");
        }
        List<Object> binds = new ArrayList<>();
        String jdbcSql = bindNames(sql, params == null ? Map.of() : params, binds);
        List<Map<String, Object>> out = new ArrayList<>();
        // Must be wrapped in cancelRegistry, otherwise the "cancel job" button and the time limit never reach this query;
        //    a runaway query would keep burning an Oracle session after the job was stopped.
        try (Connection raw = DriverManager.getConnection(cfg.dsJdbcUrl(), cfg.dsUser(), cfg.dsPassword());
             Connection c = cancelRegistry.track(raw, timeoutSeconds);
             PreparedStatement ps = c.prepareStatement(jdbcSql)) {
            ps.setFetchSize(500);
            if (timeoutSeconds > 0) ps.setQueryTimeout(timeoutSeconds);
            io.reporthub.reportstudio.util.TypedValues.bindAll(ps, binds);
            try (ResultSet rs = ps.executeQuery()) {
                ResultSetMetaData md = rs.getMetaData();
                int n = md.getColumnCount();
                while (rs.next()) {
                    if (out.size() >= maxItems) {
                        // Never truncate silently - the book would be missing branches while the TOC looks complete
                        log.warn("Book: loopSql returned more than maxItems={} rows - the rest are dropped; "
                                + "if unintended, raise maxItems in the config", maxItems);
                        break;
                    }
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (int i = 1; i <= n; i++) {
                        row.put(columnKey(md.getColumnLabel(i), i), rs.getObject(i));
                    }
                    out.add(row);
                }
            }
        } catch (Exception e) {
            throw new RenderException("loopSql failed: " + e, e);
        }
        return out;
    }

    /**
     * Converts {@code :name} to {@code ?} and collects the values to bind, in order.
     *
     * <p>Skips {@code ::} (Postgres cast) and anything inside quotes, so characters in string literals
     * are not mistaken for parameter names.
     */
    static String bindNames(String sql, Map<String, Object> params, List<Object> binds) {
        StringBuilder out = new StringBuilder(sql.length() + 16);
        boolean inSingle = false, inDouble = false;
        for (int i = 0; i < sql.length(); i++) {
            char ch = sql.charAt(i);
            if (!inSingle && !inDouble) {
                // Comments must be skipped, otherwise a ":name" written in a comment counts as a bind
                //    and the number of ? no longer matches the bound values, raising a misleading ORA error.
                if (ch == '-' && i + 1 < sql.length() && sql.charAt(i + 1) == '-') {
                    int nl = sql.indexOf('\n', i);
                    int end = nl < 0 ? sql.length() : nl;
                    out.append(sql, i, end);
                    i = end - 1;
                    continue;
                }
                if (ch == '/' && i + 1 < sql.length() && sql.charAt(i + 1) == '*') {
                    int close = sql.indexOf("*/", i + 2);
                    int end = close < 0 ? sql.length() : close + 2;
                    out.append(sql, i, end);
                    i = end - 1;
                    continue;
                }
            }
            if (ch == '\'' && !inDouble) { inSingle = !inSingle; out.append(ch); continue; }
            if (ch == '"' && !inSingle) { inDouble = !inDouble; out.append(ch); continue; }
            if (inSingle || inDouble || ch != ':') { out.append(ch); continue; }
            if (i + 1 < sql.length() && sql.charAt(i + 1) == ':') { out.append("::"); i++; continue; }
            int j = i + 1;
            while (j < sql.length() && (Character.isLetterOrDigit(sql.charAt(j)) || sql.charAt(j) == '_')) j++;
            if (j == i + 1) { out.append(ch); continue; }
            String name = sql.substring(i + 1, j);
            binds.add(params.get(name.toUpperCase()) != null ? params.get(name.toUpperCase()) : params.get(name));
            out.append('?');
            i = j - 1;
        }
        return out.toString();
    }

    // ─────────────────────────────────────────────── Resolve the child report up front

    /** Everything needed to render a child, resolved from the database once before fan-out */
    private record ChildSpec(String code, String name, String engine, String datasourceId,
                             String templateKey, Map<String, String> subreports,
                             String configJson, String sqlStatement,
                             EngineConfig engineConfig, boolean viaResolver) { }

    private ChildSpec resolveChild(String childCode, RenderRequest req) {
        Report child = reports.findByCode(childCode)
                .orElseThrow(() -> new RenderException("Child report '" + childCode + "' not found in the registry"));

        String engine = child.getEngine();
        String dsId = child.getDatasourceId() != null ? child.getDatasourceId() : req.datasourceId();
        String templateKey = null;
        Map<String, String> subreports = new LinkedHashMap<>();
        String configJson = null;
        String childSql = null;

        // Pick the unit that produces PDF (no pinned format = usable) - matches what RenderWorker selects at run time
        ReportUnit unit = units.findByReportCodeAndEnabledTrueOrderBySortOrderAscIdAsc(childCode).stream()
                .filter(u -> u.getFmt() == null || u.getFmt().isBlank() || "PDF".equalsIgnoreCase(u.getFmt()))
                .findFirst().orElse(null);
        if (unit != null) {
            engine = unit.getEngine();
            if (unit.getDatasourceId() != null) dsId = unit.getDatasourceId();
            configJson = unit.getConfigJson();
            childSql = sqlFromConfig(configJson);
            for (ReportUnitFile f : unitFiles.findByUnitIdAndActiveTrueOrderByRoleAscUploadedAtAsc(unit.getId())) {
                if ("main".equals(f.getRole())) {
                    templateKey = f.getObjectKey();
                } else if ("subreport".equals(f.getRole()) || "resource".equals(f.getRole())) {
                    String name = f.getFileName() == null ? "" : f.getFileName();
                    boolean isTemplate = name.toLowerCase().endsWith(".jrxml");
                    if ("subreport".equals(f.getRole()) && isTemplate) {
                        subreports.put(name.contains(".") ? name.substring(0, name.lastIndexOf('.')) : name,
                                f.getObjectKey());
                    } else {
                        subreports.put(name, f.getObjectKey());
                    }
                }
            }
        }
        if (engine == null || engine.isBlank()) engine = JasperReportEngine.KIND;

        // Remote engines (component/http/...) need an installed EngineInstance - let the resolver
        // handle it; this path is rare for reports used in a book
        ReportEngine impl = registryProvider.getObject().engineForKind(engine).orElse(null);
        boolean viaResolver = impl == null || impl.requiresInstance();

        EngineConfig childCfg = EngineConfig.NONE;
        if (dsId != null && !dsId.isBlank()) {
            childCfg = datasources.findById(dsId)
                    .map(ds -> EngineConfig.NONE.withDatasource(ds.getJdbcUrl(), ds.getDbUser(), ds.getDbPassword()))
                    .orElse(EngineConfig.NONE);
        }
        return new ChildSpec(childCode, child.getName(), engine, dsId, templateKey,
                subreports.isEmpty() ? null : subreports, configJson, childSql, childCfg, viaResolver);
    }

    /** The child unit's {@code sql} key - RenderWorker extracts it the same way in normal runs */
    private String sqlFromConfig(String configJson) {
        if (configJson == null || configJson.isBlank()) return null;
        try {
            JsonNode n = mapper.readTree(configJson).path("sql");
            return n.isTextual() && !n.asText().isBlank() ? n.asText() : null;
        } catch (Exception e) {
            return null;
        }
    }

    // ─────────────────────────────────────────────────────── Render children

    private List<Path> renderChildren(ChildSpec spec, List<Map<String, Object>> rows, Path work,
                                      int parallel, boolean skipBroken, String jobId,
                                      Map<String, Object> baseParams) throws Exception {
        int n = rows.size();
        Path[] out = new Path[n];
        Map<String, String> mdc = MDC.getCopyOfContextMap();

        // Gotcha: always render the first item alone - some plugins build their own Spring context
        //    on first render via System properties; several threads entering at once would race on that setup
        out[0] = renderOne(spec, baseParams, rows.get(0), work, 0, skipBroken);
        report(jobId, 1, n, labelOf(rows.get(0)));

        if (n > 1) {
            ExecutorService pool = new ThreadPoolExecutor(
                    parallel, parallel, 0L, TimeUnit.MILLISECONDS,
                    new ArrayBlockingQueue<>(Math.max(8, n)),
                    r -> { Thread t = new Thread(r, "book-child"); t.setDaemon(true); return t; },
                    new ThreadPoolExecutor.CallerRunsPolicy());
            try {
                List<Future<Void>> futures = new ArrayList<>(n - 1);
                java.util.concurrent.atomic.AtomicInteger done =
                        new java.util.concurrent.atomic.AtomicInteger(1);
                for (int i = 1; i < n; i++) {
                    final int idx = i;
                    futures.add(pool.submit((Callable<Void>) () -> {
                        Map<String, String> prev = MDC.getCopyOfContextMap();
                        if (mdc != null) MDC.setContextMap(mdc);   // bind log + cancel button to the original job
                        try {
                            out[idx] = renderOne(spec, baseParams, rows.get(idx), work, idx, skipBroken);
                            report(jobId, done.incrementAndGet(), n, labelOf(rows.get(idx)));
                            return null;
                        } finally {
                            MDC.clear();
                            if (prev != null) MDC.setContextMap(prev);
                        }
                    }));
                }
                for (Future<Void> f : futures) {
                    try {
                        f.get();
                    } catch (java.util.concurrent.ExecutionException e) {
                        futures.forEach(x -> x.cancel(true));
                        Throwable c = e.getCause();
                        // Gotcha: OutOfMemoryError/StackOverflowError must propagate unchanged;
                        //    wrapped in RenderException the pod would carry on with a broken heap
                        if (c instanceof Error err) throw err;
                        throw (c instanceof Exception ex) ? ex : new RenderException(String.valueOf(c), c);
                    }
                }
            } finally {
                pool.shutdownNow();
                // Must wait for children to actually stop, otherwise the caller deletes the temp folder while children still write to it
                //    (leftover files in the worker's /tmp + noisy stack traces when debugging)
                try {
                    if (!pool.awaitTermination(60, TimeUnit.SECONDS)) {
                        log.warn("Book: child threads did not stop within 60 seconds of cancellation");
                    }
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                }
            }
        }

        List<Path> parts = new ArrayList<>(n);
        for (Path p : out) parts.add(p);
        return parts;
    }

    private Path renderOne(ChildSpec spec, Map<String, Object> baseParams, Map<String, Object> row,
                           Path work, int idx, boolean skipBroken) {
        Map<String, Object> params = childParams(baseParams, row);
        RenderRequest childReq = new RenderRequest(
                spec.code(), spec.name(), spec.engine(), "pdf",
                params, spec.sqlStatement(), spec.datasourceId(),
                spec.templateKey(), spec.subreports(), spec.configJson(), null);

        try {
            RenderResult r = spec.viaResolver()
                    ? resolverProvider.getObject().render(childReq)
                    : registryProvider.getObject().engineForKind(spec.engine())
                            .orElseThrow(() -> new RenderException("No engine '" + spec.engine() + "'"))
                            .render(childReq, spec.engineConfig());
            Path f = work.resolve(String.format("%05d.pdf", idx));
            if (r.filePath() != null) {
                Files.move(r.filePath(), f, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            } else {
                Files.write(f, r.bytes());
            }
            return f;
        } catch (Exception e) {
            String who = labelOf(row);
            if (skipBroken) {
                log.warn("Book: skipping item '{}' because rendering failed — {}", who, e.toString());
                return null;
            }
            throw new RenderException("Rendering item '" + who + "' failed: " + e, e);
        }
    }

    /**
     * Parameters passed to one child report.
     *
     * <p>Must always start from the run params - the run's own parameters/watermark/USER live there, not in the loopSql
     * row. Omitting them would make every child silently fall back to its parameter defaults.
     *
     * <p>Row columns may override run values (this item's own values), except the two reserved TOC names.
     */
    static Map<String, Object> childParams(Map<String, Object> baseParams, Map<String, Object> row) {
        Map<String, Object> params = new LinkedHashMap<>(baseParams == null ? Map.of() : baseParams);
        if (row != null) {
            row.forEach((k, v) -> {
                if (!isReserved(k)) params.put(k, v);
            });
        }
        return params;
    }

    /**
     * Key name for one loopSql column - the parameter name the child report receives.
     *
     * <p>Oracle returns unquoted aliases in upper case, Postgres in lower case,
     * so left as the driver returns them, the reserved TOC names and child parameters would vary by database;
     * upper case is therefore the default.
     *
     * <p>Gotcha: except when the driver returns a "mixed-case" name, which only happens when the author quoted
     * it, e.g. {@code AS "branchReport"} - meaning that exact name is intended (some child reports
     * take camelCase parameters). Upper-casing it to BRANCHREPORT would match nothing
     * and the child would silently get an empty value.
     */
    static String columnKey(String label, int index) {
        if (label == null || label.isBlank()) return "C" + index;
        boolean mixed = !label.equals(label.toUpperCase()) && !label.equals(label.toLowerCase());
        return mixed ? label : label.toUpperCase();
    }

    /** Reserved TOC names, compared case-insensitively because keys may come from a driver returning lower case */
    private static boolean isReserved(String key) {
        return COL_LABEL.equalsIgnoreCase(key) || COL_GROUP.equalsIgnoreCase(key);
    }

    /** Read a reserved name's value from the row, ignoring key case */
    private static Object reservedValue(Map<String, Object> row, String name) {
        for (Map.Entry<String, Object> e : row.entrySet()) {
            if (name.equalsIgnoreCase(e.getKey())) return e.getValue();
        }
        return null;
    }

    /** Human-readable name of one row's item - used in progress logs and error messages */
    private static String labelOf(Map<String, Object> row) {
        Object l = reservedValue(row, COL_LABEL);
        if (l != null && !String.valueOf(l).isBlank()) return String.valueOf(l);
        return String.valueOf(row.values().stream().filter(java.util.Objects::nonNull).findFirst().orElse("?"));
    }

    /** Progress runs within 35-85 so it does not clash with the stages before/after set by RenderWorker */
    private void report(String jobId, int done, int total, String who) {
        // Update roughly every 2% to avoid opening new transactions more often than needed
        int step = Math.max(1, total / 50);
        if (done % step != 0 && done != total) return;
        // Progress writes must never fail the whole book - it may have been rendering for ten minutes
        try {
            if (jobId != null) progress.set(jobId, 35 + (int) (50.0 * done / total));
        } catch (Exception e) {
            log.warn("Book: progress update failed (render unaffected): {}", e.toString());
        }
        log.info("Book: rendered {}/{} - latest {}", done, total, who);
    }

    // ──────────────────────────────────────────────────── Assemble book + TOC

    private RenderResult assemble(List<Map<String, Object>> rows, List<Path> parts, int drop,
                                  int coverPages, String tocTitle, Path work, RenderRequest req)
            throws Exception {
        List<Path> body = new ArrayList<>();
        List<PdfBook.Entry> toc = new ArrayList<>();
        int page = 1;
        int skipped = 0;
        for (int i = 0; i < parts.size(); i++) {
            Path p = parts.get(i);
            if (p == null) { skipped++; continue; }
            int pages = PdfBook.pageCount(p) - drop;
            if (pages <= 0) {
                // Gotcha: a branch with no data yields only a cover (+TOC) - a child cover must not go into the book
                skipped++;
                continue;
            }
            Map<String, Object> row = rows.get(i);
            toc.add(new PdfBook.Entry(str(reservedValue(row, COL_GROUP)),
                    str(reservedValue(row, COL_LABEL)), page));
            body.add(p);
            page += pages;
        }
        if (body.isEmpty()) {
            throw new RenderException("No item has any content after dropping " + drop + " leading pages");
        }
        if (skipped > 0) {
            log.warn("Book: skipped {} items with no content ({} items left in the book)", skipped, body.size());
        }

        // Book cover = the leading pages of the first child with content (before leading pages are dropped).
        Path coverFile = null;
        if (coverPages > 0) {
            for (Path p : parts) {
                if (p == null) continue;
                coverFile = PdfBook.extractLeading(p, coverPages, work.resolve("cover.pdf"));
                break;
            }
            if (coverFile == null) {
                log.warn("Book: {} cover page(s) requested but the child report is too short; producing the book without a cover", coverPages);
            }
        }
        int lead = coverFile == null ? 0 : coverPages;

        Path tocFile = null;
        if (tocTitle != null && !tocTitle.isBlank()) {
            tocFile = PdfBook.buildToc(tocTitle, toc, work.resolve("toc.pdf"), lead);
            // child parts are watermarked by the renderer; the TOC is built here, so stamp it the same way
            String mark = io.reporthub.reportstudio.render.PdfWatermark.textOf(req.params());
            if (mark != null && !mark.isBlank()) {
                Files.write(tocFile, io.reporthub.reportstudio.render.PdfWatermark.stamp(Files.readAllBytes(tocFile), mark));
            }
        }
        Path outFile = Files.createTempFile("rs-book-out-", ".pdf");
        long size;
        try {
            PdfBook.merge(coverFile, tocFile, body, drop, outFile);
            size = Files.size(outFile);
        } catch (Exception e) {
            // Gotcha: only RenderWorker deletes this file, after a successful upload - if joining fails here
            //    a half-written file stays in the worker's /tmp forever, piling up until the pod is evicted
            PdfBook.deleteQuietly(outFile);
            throw e;
        }
        log.info("Book {} done: {} items · {} bytes", req.code(), body.size(), size);
        return RenderResult.ofFile(outFile, "application/pdf", "pdf", size);
    }

    // ─────────────────────────────────────────────────────────── utilities

    private JsonNode readConfig(String configJson) {
        if (configJson == null || configJson.isBlank()) {
            throw new RenderException("engine 'book' requires a config on the output (childReport / loopSql)");
        }
        try {
            return mapper.readTree(configJson);
        } catch (Exception e) {
            throw new RenderException("config of the book output is not readable JSON: " + e, e);
        }
    }

    private static String text(JsonNode n, String key, String dflt) {
        JsonNode v = n.path(key);
        return v.isMissingNode() || v.isNull() || v.asText().isBlank() ? dflt : v.asText().trim();
    }

    private static int number(JsonNode n, String key, int dflt) {
        String s = text(n, key, null);
        if (s == null) return dflt;
        try {
            return Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            return dflt;
        }
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }
}
