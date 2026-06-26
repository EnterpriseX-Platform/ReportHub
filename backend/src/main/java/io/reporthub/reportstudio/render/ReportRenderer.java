package io.reporthub.reportstudio.render;

import net.sf.jasperreports.engine.JasperCompileManager;
import net.sf.jasperreports.engine.util.JRLoader;
import net.sf.jasperreports.engine.JasperExportManager;
import net.sf.jasperreports.engine.JasperFillManager;
import net.sf.jasperreports.engine.JasperPrint;
import net.sf.jasperreports.engine.JasperReport;
import net.sf.jasperreports.engine.JRParameter;
import net.sf.jasperreports.engine.JRPrintElement;
import net.sf.jasperreports.engine.JRPrintFrame;
import net.sf.jasperreports.engine.JRPrintPage;
import net.sf.jasperreports.engine.JRPrintText;
import net.sf.jasperreports.engine.export.ooxml.JRXlsxExporter;
import net.sf.jasperreports.export.SimpleExporterInput;
import net.sf.jasperreports.export.SimpleOutputStreamExporterOutput;
import net.sf.jasperreports.export.SimpleXlsxReportConfiguration;
import net.sf.jasperreports.engine.data.JRBeanCollectionDataSource;
import net.sf.jasperreports.engine.design.JRDesignBand;
import net.sf.jasperreports.engine.design.JRDesignExpression;
import net.sf.jasperreports.engine.design.JRDesignField;
import net.sf.jasperreports.engine.design.JRDesignSection;
import net.sf.jasperreports.engine.design.JRDesignStaticText;
import net.sf.jasperreports.engine.design.JRDesignTextField;
import net.sf.jasperreports.engine.design.JasperDesign;
import net.sf.jasperreports.engine.type.HorizontalTextAlignEnum;
import net.sf.jasperreports.engine.type.ModeEnum;
import org.apache.poi.ss.usermodel.BorderStyle;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.HorizontalAlignment;
import org.apache.poi.ss.usermodel.IndexedColors;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.streaming.SXSSFWorkbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.awt.Color;
import java.io.BufferedWriter;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Real document renderer for Report Studio. No simulation:
 * <ul>
 *   <li><b>PDF</b> — JasperReports. The bundled {@code jasper/generic.jrxml} is compiled at
 *       runtime for the standard region/amount fact table; for arbitrary SQL result shapes a
 *       generic {@link JasperDesign} is built programmatically so any column set renders.</li>
 *   <li><b>XLSX</b> — a real Apache POI workbook.</li>
 *   <li><b>CSV</b> — RFC-4180 style {@code text/csv}.</li>
 * </ul>
 * Rows come from {@code sqlStatement} (run against the primary Postgres {@link JdbcTemplate}) when
 * supplied, otherwise from a fixed sample region/amount dataset so output always has content.
 */
@Service
public class ReportRenderer {

    private static final Logger log = LoggerFactory.getLogger(ReportRenderer.class);

    private static final String TEMPLATE_PATH = "/jasper/generic.jrxml";

    @Value("${app.report.office-name}")
    private String officeName;

    @Value("${app.report.generated-at-pattern}")
    private String generatedAtPattern;

    @Value("${app.report.generated-at-locale}")
    private String generatedAtLocale;

    /** Abort a fill that runs longer than this (ms) so one runaway report can't peg the
     *  CPU and block the single-partition Kafka queue. 0 disables. Default 5 min (raised from
     *  2 min on 2026-06-15 so genuinely heavy reports like BCE02-02-RPT04 can finish). */
    @Value("${app.report.render-timeout-ms:300000}")
    private long renderTimeoutMs;

    /** Abort a fill that exceeds this many pages (a runaway/cartesian dataset). 0 disables. */
    @Value("${app.report.render-max-pages:10000}")
    private int renderMaxPages;

    private DateTimeFormatter tsFmt;

    private final JdbcTemplate jdbcTemplate;
    private final io.reporthub.reportstudio.storage.ObjectStorageService storage;
    private final io.reporthub.reportstudio.repo.DatasourceRepository datasources;

    public ReportRenderer(JdbcTemplate jdbcTemplate,
                          io.reporthub.reportstudio.storage.ObjectStorageService storage,
                          io.reporthub.reportstudio.repo.DatasourceRepository datasources) {
        this.jdbcTemplate = jdbcTemplate;
        this.storage = storage;
        this.datasources = datasources;
    }

    @jakarta.annotation.PostConstruct
    void init() {
        String[] parts = generatedAtLocale.split("_", 2);
        Locale locale = parts.length == 2 ? new Locale(parts[0], parts[1]) : new Locale(parts[0]);
        tsFmt = DateTimeFormatter.ofPattern(generatedAtPattern, locale);

        // JasperReports built-in governors: abort a runaway fill instead of letting it peg the
        // CPU forever. With the single-partition report.jobs topic, one hung render blocks every
        // other report (this is what amplified the 2026-06-15 crash-loop). A JRGovernorException
        // surfaces as a normal render failure → the job is marked error and the queue moves on.
        net.sf.jasperreports.engine.JasperReportsContext jrCtx =
                net.sf.jasperreports.engine.DefaultJasperReportsContext.getInstance();
        if (renderTimeoutMs > 0) {
            jrCtx.setProperty("net.sf.jasperreports.governor.timeout.enabled", "true");
            jrCtx.setProperty("net.sf.jasperreports.governor.timeout", String.valueOf(renderTimeoutMs));
        }
        if (renderMaxPages > 0) {
            jrCtx.setProperty("net.sf.jasperreports.governor.max.pages.enabled", "true");
            jrCtx.setProperty("net.sf.jasperreports.governor.max.pages", String.valueOf(renderMaxPages));
        }
    }

    // ------------------------------------------------------------------------
    // Public entry point
    // ------------------------------------------------------------------------

    /**
     * Query-export entry point used by the standalone {@code QueryExportEngine} (engine=sql): run the
     * report's own SQL against ITS datasource and stream the result straight to CSV/XLSX/PDF.
     */
    public RenderResult renderQuery(RenderRequest req) {
        if (req == null) {
            throw new RenderException("RenderRequest must not be null");
        }
        if (!hasText(req.sqlStatement())) {
            throw new RenderException("Query-export engine requires a SQL statement "
                    + "(set the render unit's configJson to {\"sql\": \"...\"})");
        }
        return renderQueryExport(req, normalizeFormat(req.format()));
    }

    /**
     * Render an already-fetched {@link TabularData} to the requested format. Used by engines that
     * source their own rows (e.g. the api engine fetching JSON) and just need the CSV/XLSX/PDF writers.
     */
    public RenderResult renderTabular(RenderRequest req, TabularData data) {
        if (req == null || data == null) {
            throw new RenderException("RenderRequest and data must not be null");
        }
        String format = normalizeFormat(req.format());
        return switch (format) {
            case "pdf" -> renderPdf(req, data, isFactShape(data));
            case "xlsx" -> renderXlsx(req, data);
            default -> renderCsv(req, data);
        };
    }

    public RenderResult render(RenderRequest req) {
        if (req == null) {
            throw new RenderException("RenderRequest must not be null");
        }
        String format = normalizeFormat(req.format());

        // Query-export engine: run the report's own SQL against ITS datasource and stream the
        // result straight to CSV/XLSX/PDF — no template, no in-memory row buffering. This handles
        // result sets of millions of rows (the BCE extract case) without OOM.
        if (isQueryEngine(req.engine()) && hasText(req.sqlStatement())) {
            return renderQueryExport(req, format);
        }

        boolean useSql = hasText(req.sqlStatement());
        TabularData data = useSql ? runSql(req.sqlStatement()) : sampleData();

        // For the region/amount fact shape we can use the rich JRXML template; this is the
        // case for the sample dataset and for SQL that returns the canonical 3 columns.
        boolean factShape = isFactShape(data);

        try {
            // A render unit with an UPLOADED Jasper template takes priority for PDF output.
            // Propagate failures so the job is marked error with a useful message instead of
            // silently producing a generic layout that looks like a "default template" output.
            if ("pdf".equals(format) && hasText(req.templateKey())) {
                return renderUploadedPdf(req, data);
            }
            if ("xlsx".equals(format) && hasText(req.templateKey())) {
                return renderUploadedXlsx(req, data);
            }
            return switch (format) {
                case "pdf" -> renderPdf(req, data, factShape);
                case "xlsx" -> renderXlsx(req, data);
                case "csv" -> renderCsv(req, data);
                default -> throw new RenderException("Unsupported format: " + req.format());
            };
        } catch (RenderException re) {
            throw re;
        } catch (Exception e) {
            throw new RenderException(
                    "Failed to render report " + safe(req.code()) + " as " + format + ": " + e.getMessage(), e);
        }
    }

    // ------------------------------------------------------------------------
    // PDF from an UPLOADED render-unit template (+ subreports)
    // ------------------------------------------------------------------------

    /**
     * Compile the uploaded main template (.jrxml, or load a precompiled .jasper), compile each
     * uploaded subreport and expose it as a report parameter of the same name, then fill with
     * the runtime parameters and the tabular data (fields resolvable by column name or c0..cN).
     */
    private RenderResult renderUploadedPdf(RenderRequest req, TabularData data) throws Exception {
        JasperReport main = loadTemplate(req.templateKey());

        Map<String, Object> params = new HashMap<>();
        if (req.params() != null) params.putAll(req.params());
        coerceDeclaredParams(main, params);
        params.put("officeName", officeName);
        params.put("REPORT_TITLE", safe(req.name(), safe(req.code())));
        params.put("REPORT_CODE", safe(req.code()));
        params.put("GENERATED_AT", LocalDateTime.now().format(tsFmt));

        // Compile each subreport and inject it TWO ways:
        //   1. As a named JasperReport parameter ($P{basename}) — the "clean" pattern.
        //   2. Written as a compiled .jasper into a temp dir so templates that use the
        //      $P{SUBREPORT_DIR}+"name.jasper" pattern (the common Jaspersoft Studio default)
        //      also resolve correctly.  SUBREPORT_DIR is set to the temp dir path.
        java.nio.file.Path subreportDir = null;
        try {
            subreportDir = prepareResources(req, params);

            // When a datasource is configured, open a real JDBC connection and fail loudly if
            // it cannot be established — a missing/broken datasource must not silently render
            // with sample data and pass as a successful job.
            if (hasText(req.datasourceId())) {
                try (Connection conn = openConnection(req.datasourceId())) {
                    JasperPrint print = JasperFillManager.fillReport(main, params, conn);
                    byte[] pdf = JasperExportManager.exportReportToPdf(print);
                    return new RenderResult(pdf, "application/pdf", "pdf", pdf.length);
                }
            }

            // No datasource configured — fill from the TabularData (columns resolvable by name and c0..cN).
            List<Map<String, ?>> rows = new ArrayList<>();
            for (List<String> r : data.rows()) {
                Map<String, Object> m = new HashMap<>();
                for (int i = 0; i < r.size(); i++) {
                    m.put("c" + i, r.get(i));
                    if (i < data.columnCount()) m.put(data.columns().get(i), r.get(i));
                }
                rows.add(m);
            }

            JasperPrint print = JasperFillManager.fillReport(main, params, new MapFieldDataSource(rows));
            byte[] pdf = JasperExportManager.exportReportToPdf(print);
            return new RenderResult(pdf, "application/pdf", "pdf", pdf.length);
        } finally {
            if (subreportDir != null) {
                try {
                    java.nio.file.Files.walk(subreportDir)
                            .sorted(java.util.Comparator.reverseOrder())
                            .map(java.nio.file.Path::toFile)
                            .forEach(java.io.File::delete);
                } catch (Exception ignore) {}
            }
        }
    }

    /** Open a JDBC connection for the given datasource ID. Throws {@link RenderException} on any failure. */
    private Connection openConnection(String datasourceId) throws Exception {
        var ds = datasources.findById(datasourceId)
                .orElseThrow(() -> new RenderException("Datasource not found: " + datasourceId));
        String url = ds.getJdbcUrl();
        if (!hasText(url)) {
            throw new RenderException("Datasource " + datasourceId + " has no JDBC URL configured");
        }
        try {
            return DriverManager.getConnection(url, ds.getDbUser(), ds.getDbPassword());
        } catch (Exception e) {
            throw new RenderException(
                    "Cannot connect to datasource " + datasourceId + " (" + url + "): " + e.getMessage(), e);
        }
    }

    /** Mirror of {@link #renderUploadedPdf} using JRXlsxExporter instead of PDF export. */
    private RenderResult renderUploadedXlsx(RenderRequest req, TabularData data) throws Exception {
        JasperReport main = loadTemplate(req.templateKey());

        Map<String, Object> params = new HashMap<>();
        if (req.params() != null) params.putAll(req.params());
        coerceDeclaredParams(main, params);
        params.put("officeName", officeName);
        params.put("REPORT_TITLE", safe(req.name(), safe(req.code())));
        params.put("REPORT_CODE", safe(req.code()));
        params.put("GENERATED_AT", LocalDateTime.now().format(tsFmt));

        java.nio.file.Path subreportDir = null;
        try {
            subreportDir = prepareResources(req, params);

            JasperPrint print;
            if (hasText(req.datasourceId())) {
                try (Connection conn = openConnection(req.datasourceId())) {
                    print = JasperFillManager.fillReport(main, params, conn);
                }
            } else {
                List<Map<String, ?>> rows = new ArrayList<>();
                for (List<String> r : data.rows()) {
                    Map<String, Object> m = new HashMap<>();
                    for (int i = 0; i < r.size(); i++) {
                        m.put("c" + i, r.get(i));
                        if (i < data.columnCount()) m.put(data.columns().get(i), r.get(i));
                    }
                    rows.add(m);
                }
                print = JasperFillManager.fillReport(main, params, new MapFieldDataSource(rows));
            }

            sanitizeNullText(print);

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            JRXlsxExporter exporter = new JRXlsxExporter();
            exporter.setExporterInput(new SimpleExporterInput(print));
            exporter.setExporterOutput(new SimpleOutputStreamExporterOutput(baos));
            SimpleXlsxReportConfiguration config = new SimpleXlsxReportConfiguration();
            config.setOnePagePerSheet(false);
            exporter.setConfiguration(config);
            exporter.exportReport();
            byte[] xlsx = baos.toByteArray();
            return new RenderResult(xlsx,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "xlsx", xlsx.length);
        } finally {
            if (subreportDir != null) {
                try {
                    java.nio.file.Files.walk(subreportDir)
                            .sorted(java.util.Comparator.reverseOrder())
                            .map(java.nio.file.Path::toFile)
                            .forEach(java.io.File::delete);
                } catch (Exception ignore) {}
            }
        }
    }

    /**
     * Work around a JasperReports XLSX-export NPE: {@code JRXlsxExporter.exportText} calls
     * {@code getStyledText().getText()}, and {@code getStyledText()} returns null when a printed text
     * element's text is null — which happens for any {@code <textField>} with {@code isBlankWhenNull="false"}
     * (the default) whose expression evaluated to null for that run's data. The PDF exporter null-checks,
     * so the same report renders to PDF but blows up to XLSX, intermittently, depending on the data.
     * Replacing null print text with "" before the XLSX export makes the styled text non-null and is
     * harmless (an empty cell either way). Applies to every report, not just one template.
     */
    private static void sanitizeNullText(JasperPrint print) {
        if (print == null || print.getPages() == null) return;
        for (JRPrintPage page : print.getPages()) {
            if (page != null) sanitizeNullText(page.getElements());
        }
    }

    private static void sanitizeNullText(java.util.List<JRPrintElement> elements) {
        if (elements == null) return;
        for (JRPrintElement el : elements) {
            if (el instanceof JRPrintText t) {
                if (t.getFullText() == null) t.setText("");
            } else if (el instanceof JRPrintFrame f) {
                sanitizeNullText(f.getElements());
            }
        }
    }

    /**
     * Coerce request parameter values — which always arrive as JSON Strings — to the types the
     * template declares. Jaspersoft Studio commonly types a parameter as {@code java.lang.Integer},
     * {@code java.util.Date}, etc.; passing a raw String then fails at fill time with a
     * {@code ClassCastException} (e.g. GIS_RPT01's {@code YEAR_TH} is an Integer). An unknown or
     * unparseable value is left untouched so Jasper still surfaces a precise error.
     */
    private void coerceDeclaredParams(JasperReport report, Map<String, Object> params) {
        if (report.getParameters() == null) return;
        for (JRParameter p : report.getParameters()) {
            if (p.isSystemDefined()) continue;
            Object val = params.get(p.getName());
            if (!(val instanceof String s)) continue;
            Class<?> type = p.getValueClass();
            if (type == null || type == String.class || type == Object.class) continue;
            String t = s.trim();
            if (t.isEmpty()) continue;
            try {
                params.put(p.getName(), convertParam(t, type));
            } catch (RuntimeException ex) {
                // leave the original String — a genuinely incompatible value fails loudly downstream
            }
        }
    }

    private Object convertParam(String s, Class<?> type) {
        if (type == Integer.class) return Integer.valueOf(s);
        if (type == Long.class) return Long.valueOf(s);
        if (type == Short.class) return Short.valueOf(s);
        if (type == Byte.class) return Byte.valueOf(s);
        if (type == Double.class) return Double.valueOf(s);
        if (type == Float.class) return Float.valueOf(s);
        if (type == java.math.BigDecimal.class) return new java.math.BigDecimal(s);
        if (type == java.math.BigInteger.class) return new java.math.BigInteger(s);
        if (type == Boolean.class) return Boolean.valueOf(s);
        if (type == java.sql.Timestamp.class) return java.sql.Timestamp.valueOf(java.time.LocalDateTime.parse(s));
        if (type == java.sql.Date.class || type == java.util.Date.class)
            return java.sql.Date.valueOf(java.time.LocalDate.parse(s));
        return s;
    }

    /** Fetch a template from object storage and compile (.jrxml) or load (.jasper) it. */
    private JasperReport loadTemplate(String objectKey) throws Exception {
        byte[] bytes = storage.get(objectKey);
        if (objectKey.toLowerCase().endsWith(".jasper")) {
            try (InputStream in = new java.io.ByteArrayInputStream(bytes)) {
                return (JasperReport) JRLoader.loadObject(in);
            }
        }
        String xml = normalizeSubreportRefs(new String(bytes, StandardCharsets.UTF_8));
        try (InputStream in = new java.io.ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8))) {
            return JasperCompileManager.compileReport(in);
        }
    }

    // A subreportExpression that is a BARE quoted filename literal, e.g. <![CDATA["X_Sub1.jasper"]]>
    // (no $P{...}, no concatenation). Group 1 = the filename.
    private static final Pattern BARE_SUBREPORT_REF = Pattern.compile(
            "(?s)<subreportExpression>\\s*<!\\[CDATA\\[\\s*\"([^\"$+{}]+\\.(?:jasper|jrxml))\"\\s*\\]\\]>\\s*</subreportExpression>");

    /**
     * Rewrite bare subreport references so they resolve from SUBREPORT_DIR. Some templates reference a
     * subreport by a bare filename ({@code <subreportExpression><![CDATA["X_Sub1.jasper"]]>...}) instead
     * of the usual {@code $P{SUBREPORT_DIR}+"X_Sub1.jasper"}; Jasper then can't find it ("Resource not
     * found at: X_Sub1.jasper"). We prepend {@code $P{SUBREPORT_DIR}+} so the absolute temp-dir path is
     * used (which the default repository resolves). Only applied when the template actually declares a
     * SUBREPORT_DIR parameter, so the rewritten expression always compiles.
     */
    private static String normalizeSubreportRefs(String xml) {
        if (xml == null || !xml.contains("name=\"SUBREPORT_DIR\"")) {
            return xml;
        }
        Matcher m = BARE_SUBREPORT_REF.matcher(xml);
        StringBuilder out = new StringBuilder(xml.length() + 64);
        while (m.find()) {
            // Compiled subreports are materialized as "{base}.jasper", so normalize the extension.
            String base = m.group(1).replaceFirst("\\.(?:jasper|jrxml)$", "");
            m.appendReplacement(out, Matcher.quoteReplacement(
                    "<subreportExpression><![CDATA[$P{SUBREPORT_DIR}+\"" + base + ".jasper\"]]></subreportExpression>"));
        }
        m.appendTail(out);
        return out.toString();
    }

    /**
     * Materialize a unit's "subreport"-role files into {@code subreportDir} and expose them to
     * {@code params}. A {@code .jrxml}/{@code .jasper} file is compiled and injected both as a
     * {@code $P{basename}} parameter AND saved as {@code {basename}.jasper} (so the common
     * {@code $P{SUBREPORT_DIR}+"x.jasper"} pattern resolves). Any OTHER file (image / font / …) is a
     * resource: its raw bytes are copied into the dir under its original filename so jrxml elements
     * like {@code $P{SUBREPORT_DIR}+"BB_logo.png"} resolve. Resources are NEVER parsed as XML — that
     * was the cause of "Invalid byte 1 of 1-byte UTF-8 sequence" when a PNG was compiled as a report.
     */
    /** MinIO key prefix for global shared resources. Must match ResourceController.PREFIX. */
    private static final String SHARED_RESOURCE_PREFIX = "shared/";

    /**
     * Stage every resource a render may need into a temp dir and expose it as SUBREPORT_DIR. Order:
     * (1) GLOBAL shared resources (logos/images/fonts uploaded in Settings) so they are available to
     * EVERY report, then (2) this report's own unit files which OVERRIDE a shared file of the same name.
     * Unit {@code .jrxml}/{@code .jasper} are compiled and injected as {@code $P{basename}} + saved as
     * {@code {basename}.jasper}; everything else is copied raw. Returns {@code null} (no temp dir) only
     * when there are neither shared resources nor unit files.
     */
    private java.nio.file.Path prepareResources(RenderRequest req, Map<String, Object> params) throws Exception {
        Map<String, String> subs = req.subreports();
        boolean hasUnit = subs != null && !subs.isEmpty();
        List<io.reporthub.reportstudio.storage.StoredObjectMeta> shared = storage.list(SHARED_RESOURCE_PREFIX);
        if (!hasUnit && shared.isEmpty()) {
            return null;
        }
        java.nio.file.Path dir = java.nio.file.Files.createTempDirectory("jrsubreport-");
        // (1) Global shared resources first.
        for (var s : shared) {
            String name = s.objectKey().substring(s.objectKey().lastIndexOf('/') + 1);
            if (name.isBlank()) continue;
            java.nio.file.Files.write(dir.resolve(name), storage.get(s.objectKey()));
        }
        // (2) This report's unit files (override shared by filename).
        if (hasUnit) {
            for (Map.Entry<String, String> sub : subs.entrySet()) {
                String key = sub.getValue();
                String lower = key == null ? "" : key.toLowerCase();
                if (lower.endsWith(".jrxml") || lower.endsWith(".jasper")) {
                    JasperReport compiled = loadTemplate(key);
                    params.put(sub.getKey(), compiled);
                    java.nio.file.Path dest = dir.resolve(sub.getKey() + ".jasper");
                    try (java.io.OutputStream os = java.nio.file.Files.newOutputStream(dest)) {
                        net.sf.jasperreports.engine.util.JRSaver.saveObject(compiled, os);
                    }
                } else {
                    // Resource (image / font / …): drop the raw bytes in under the original filename.
                    java.nio.file.Files.write(dir.resolve(sub.getKey()), storage.get(key));
                }
            }
        }
        params.put("SUBREPORT_DIR", dir.toString() + java.io.File.separator);
        return dir;
    }

    // ------------------------------------------------------------------------
    // PDF (JasperReports)
    // ------------------------------------------------------------------------

    private RenderResult renderPdf(RenderRequest req, TabularData data, boolean factShape) {
        byte[] pdf = factShape
                ? renderFactPdf(req, data)
                : renderGenericPdf(req, data);
        return new RenderResult(pdf, "application/pdf", "pdf", pdf.length);
    }

    /** Compile the bundled JRXML and fill it with FactRow beans -> PDF bytes. */
    private byte[] renderFactPdf(RenderRequest req, TabularData data) {
        try (InputStream tpl = ReportRenderer.class.getResourceAsStream(TEMPLATE_PATH)) {
            if (tpl == null) {
                throw new RenderException("Bundled template not found on classpath: " + TEMPLATE_PATH);
            }
            JasperReport jasper = JasperCompileManager.compileReport(tpl);

            List<FactRow> beans = toFactRows(data);
            Map<String, Object> params = new HashMap<>();
            params.put("officeName", officeName);
            params.put("REPORT_TITLE", safe(req.name(), "Summary Report"));
            params.put("REPORT_CODE", safe(req.code()));
            params.put("GENERATED_AT", LocalDateTime.now().format(tsFmt));

            JRBeanCollectionDataSource ds = new JRBeanCollectionDataSource(beans);
            JasperPrint print = JasperFillManager.fillReport(jasper, params, ds);
            return JasperExportManager.exportReportToPdf(print);
        } catch (RenderException re) {
            throw re;
        } catch (Exception e) {
            throw new RenderException("Jasper PDF (fact) export failed: " + e.getMessage(), e);
        }
    }

    /**
     * Programmatically build a generic {@link JasperDesign} that renders any column shape from a
     * SQL result set (used when the result is not the canonical region/amount table).
     */
    private byte[] renderGenericPdf(RenderRequest req, TabularData data) {
        try {
            int cols = Math.max(1, data.columnCount());
            int pageWidth = 595;
            int margin = 40;
            int usable = pageWidth - 2 * margin;
            int colWidth = usable / cols;

            JasperDesign design = new JasperDesign();
            design.setName("generic-sql");
            design.setPageWidth(pageWidth);
            design.setPageHeight(842);
            design.setLeftMargin(margin);
            design.setRightMargin(margin);
            design.setTopMargin(margin);
            design.setBottomMargin(margin);
            design.setColumnWidth(usable);

            // Fields c0..cN (all String).
            for (int i = 0; i < cols; i++) {
                JRDesignField field = new JRDesignField();
                field.setName("c" + i);
                field.setValueClass(String.class);
                design.addField(field);
            }

            // Title band.
            JRDesignBand title = new JRDesignBand();
            title.setHeight(70);
            title.addElement(centeredStatic(officeName, 0, usable, 26, 15, true));
            title.addElement(centeredStatic(safe(req.name(), "Report"), 28, usable, 22, 12, true));
            title.addElement(centeredStatic(
                    (hasText(req.code()) ? "Report code " + req.code() + "   " : "")
                            + "Generated " + LocalDateTime.now().format(tsFmt),
                    52, usable, 14, 8, false));
            design.setTitle(title);

            // Column header band.
            JRDesignBand header = new JRDesignBand();
            header.setHeight(22);
            int x = 0;
            for (int i = 0; i < cols; i++) {
                String name = i < data.columnCount() ? data.columns().get(i) : ("Column " + (i + 1));
                JRDesignStaticText cell = boxedStatic(name, x, colWidth, 22, true);
                cell.setMode(ModeEnum.OPAQUE);
                cell.setBackcolor(new Color(0xE8, 0xEE, 0xF7));
                header.addElement(cell);
                x += colWidth;
            }
            design.setColumnHeader(header);

            // Detail band.
            JRDesignBand detail = new JRDesignBand();
            detail.setHeight(20);
            x = 0;
            for (int i = 0; i < cols; i++) {
                JRDesignTextField tf = new JRDesignTextField();
                tf.setX(x);
                tf.setY(0);
                tf.setWidth(colWidth);
                tf.setHeight(20);
                tf.setStretchWithOverflow(true);
                tf.setBlankWhenNull(true);
                box(tf);
                JRDesignExpression expr = new JRDesignExpression();
                expr.setText("$F{c" + i + "}");
                tf.setExpression(expr);
                detail.addElement(tf);
                x += colWidth;
            }
            ((JRDesignSection) design.getDetailSection()).addBand(detail);

            JasperReport jasper = JasperCompileManager.compileReport(design);

            // Build row beans as Map<String,?> keyed c0..cN for JRBeanCollectionDataSource.
            List<Map<String, ?>> beans = new ArrayList<>();
            for (List<String> r : data.rows()) {
                Map<String, Object> m = new HashMap<>();
                for (int i = 0; i < cols; i++) {
                    m.put("c" + i, i < r.size() ? r.get(i) : "");
                }
                beans.add(m);
            }
            if (beans.isEmpty()) {
                // Guarantee at least one (empty) row so a page is always produced.
                Map<String, Object> m = new HashMap<>();
                for (int i = 0; i < cols; i++) {
                    m.put("c" + i, "");
                }
                beans.add(m);
            }

            JasperPrint print = JasperFillManager.fillReport(
                    jasper, new HashMap<>(), new MapFieldDataSource(beans));
            return JasperExportManager.exportReportToPdf(print);
        } catch (RenderException re) {
            throw re;
        } catch (Exception e) {
            throw new RenderException("Jasper PDF (generic) export failed: " + e.getMessage(), e);
        }
    }

    // ------------------------------------------------------------------------
    // XLSX (Apache POI)
    // ------------------------------------------------------------------------

    private RenderResult renderXlsx(RenderRequest req, TabularData data) {
        try (Workbook wb = new XSSFWorkbook(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Sheet sheet = wb.createSheet("Report");

            CellStyle titleStyle = wb.createCellStyle();
            Font titleFont = wb.createFont();
            titleFont.setBold(true);
            titleFont.setFontHeightInPoints((short) 13);
            titleStyle.setFont(titleFont);

            CellStyle headerStyle = wb.createCellStyle();
            Font headerFont = wb.createFont();
            headerFont.setBold(true);
            headerStyle.setFont(headerFont);
            headerStyle.setFillForegroundColor(IndexedColors.GREY_25_PERCENT.getIndex());
            headerStyle.setFillPattern(FillPatternType.SOLID_FOREGROUND);
            headerStyle.setBorderBottom(BorderStyle.THIN);
            headerStyle.setBorderTop(BorderStyle.THIN);
            headerStyle.setBorderLeft(BorderStyle.THIN);
            headerStyle.setBorderRight(BorderStyle.THIN);

            CellStyle cellStyle = wb.createCellStyle();
            cellStyle.setBorderBottom(BorderStyle.THIN);
            cellStyle.setBorderTop(BorderStyle.THIN);
            cellStyle.setBorderLeft(BorderStyle.THIN);
            cellStyle.setBorderRight(BorderStyle.THIN);

            CellStyle numStyle = wb.createCellStyle();
            numStyle.cloneStyleFrom(cellStyle);
            numStyle.setDataFormat(wb.createDataFormat().getFormat("#,##0.00"));
            numStyle.setAlignment(HorizontalAlignment.RIGHT);

            int cols = Math.max(1, data.columnCount());

            // Title rows.
            Row r0 = sheet.createRow(0);
            Cell t0 = r0.createCell(0);
            t0.setCellValue(officeName + " - " + safe(req.name(), "Report"));
            t0.setCellStyle(titleStyle);

            Row r1 = sheet.createRow(1);
            r1.createCell(0).setCellValue(
                    (hasText(req.code()) ? "Report code " + req.code() + "   " : "")
                            + "Generated " + LocalDateTime.now().format(tsFmt));

            // Header row.
            int rowIdx = 3;
            Row headerRow = sheet.createRow(rowIdx++);
            for (int c = 0; c < cols; c++) {
                Cell cell = headerRow.createCell(c);
                cell.setCellValue(c < data.columnCount() ? data.columns().get(c) : ("Column " + (c + 1)));
                cell.setCellStyle(headerStyle);
            }

            // Data rows.
            for (List<String> row : data.rows()) {
                Row xr = sheet.createRow(rowIdx++);
                for (int c = 0; c < cols; c++) {
                    Cell cell = xr.createCell(c);
                    String v = c < row.size() ? row.get(c) : "";
                    Double num = asNumber(v);
                    if (num != null) {
                        cell.setCellValue(num);
                        cell.setCellStyle(numStyle);
                    } else {
                        cell.setCellValue(v);
                        cell.setCellStyle(cellStyle);
                    }
                }
            }

            for (int c = 0; c < cols; c++) {
                sheet.autoSizeColumn(c);
            }

            wb.write(out);
            byte[] bytes = out.toByteArray();
            return new RenderResult(
                    bytes,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "xlsx",
                    bytes.length);
        } catch (IOException e) {
            throw new RenderException("XLSX export failed: " + e.getMessage(), e);
        }
    }

    // ------------------------------------------------------------------------
    // CSV
    // ------------------------------------------------------------------------

    private RenderResult renderCsv(RenderRequest req, TabularData data) {
        StringBuilder sb = new StringBuilder();
        int cols = Math.max(1, data.columnCount());

        // Header.
        for (int c = 0; c < cols; c++) {
            if (c > 0) {
                sb.append(',');
            }
            sb.append(csvEscape(c < data.columnCount() ? data.columns().get(c) : ("col" + (c + 1))));
        }
        sb.append("\r\n");

        // Rows.
        for (List<String> row : data.rows()) {
            for (int c = 0; c < cols; c++) {
                if (c > 0) {
                    sb.append(',');
                }
                sb.append(csvEscape(c < row.size() ? row.get(c) : ""));
            }
            sb.append("\r\n");
        }

        // UTF-8 BOM so Excel opens Thai text correctly.
        byte[] body = sb.toString().getBytes(StandardCharsets.UTF_8);
        byte[] bom = {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF};
        byte[] bytes = new byte[bom.length + body.length];
        System.arraycopy(bom, 0, bytes, 0, bom.length);
        System.arraycopy(body, 0, bytes, bom.length, body.length);

        return new RenderResult(bytes, "text/csv; charset=UTF-8", "csv", bytes.length);
    }

    private static String csvEscape(String v) {
        if (v == null) {
            return "";
        }
        boolean needsQuote = v.contains(",") || v.contains("\"") || v.contains("\n") || v.contains("\r");
        String escaped = v.replace("\"", "\"\"");
        return needsQuote ? "\"" + escaped + "\"" : escaped;
    }

    // ------------------------------------------------------------------------
    // Data sourcing
    // ------------------------------------------------------------------------

    /** Run arbitrary read SQL and capture columns + stringified rows. */
    private TabularData runSql(String sql) {
        try {
            return jdbcTemplate.query(sql, rs -> {
                var meta = rs.getMetaData();
                int n = meta.getColumnCount();
                List<String> columns = new ArrayList<>(n);
                for (int i = 1; i <= n; i++) {
                    String label = meta.getColumnLabel(i);
                    columns.add(label == null ? meta.getColumnName(i) : label);
                }
                TabularData data = new TabularData(columns);
                while (rs.next()) {
                    List<String> cells = new ArrayList<>(n);
                    for (int i = 1; i <= n; i++) {
                        cells.add(stringifyCell(rs.getObject(i)));
                    }
                    data.addRow(cells);
                }
                return data;
            });
        } catch (Exception e) {
            throw new RenderException("SQL execution failed: " + e.getMessage(), e);
        }
    }

    private static String stringifyCell(Object o) {
        if (o == null) {
            return "";
        }
        if (o instanceof BigDecimal bd) {
            return bd.toPlainString();
        }
        if (o instanceof Timestamp ts) {
            return ts.toLocalDateTime().toString();
        }
        return o.toString();
    }

    // ------------------------------------------------------------------------
    // Query-export engine (engine = "sql"): run the report's own SQL against ITS
    // datasource and stream the result straight to CSV / XLSX / PDF. Built to handle
    // result sets of millions of rows without buffering them on the heap.
    // ------------------------------------------------------------------------

    private static final Pattern P_PLACEHOLDER = Pattern.compile("\\$P(!?)\\{([^}]+)\\}");
    private static final int QUERY_FETCH_SIZE = 1000;
    private static final int SXSSF_WINDOW = 200;
    /** Excel's hard cap is 1,048,576 rows (incl. header); spill into a new sheet just under it. */
    private static final int XLSX_MAX_DATA_ROWS_PER_SHEET = 1_000_000;
    /** PDF is unsuitable for true bulk extracts; cap it and steer users to CSV/XLSX. */
    private static final int QUERY_PDF_MAX_ROWS = 5000;

    private static boolean isQueryEngine(String engine) {
        return "sql".equalsIgnoreCase(engine) || "query".equalsIgnoreCase(engine);
    }

    private RenderResult renderQueryExport(RenderRequest req, String format) {
        long t0 = System.currentTimeMillis();
        Connection conn = null;
        try {
            conn = hasText(req.datasourceId()) ? openConnection(req.datasourceId()) : primaryConnection();
            try { conn.setReadOnly(true); } catch (Exception ignore) { /* not all drivers support it */ }

            PreparedSql ps = prepareSql(req.sqlStatement(), req.params());
            try (PreparedStatement st = conn.prepareStatement(
                    ps.sql(), ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY)) {
                st.setFetchSize(QUERY_FETCH_SIZE);
                if (renderTimeoutMs > 0) {
                    long secs = Math.max(1, renderTimeoutMs / 1000);
                    st.setQueryTimeout((int) Math.min(Integer.MAX_VALUE, secs));
                }
                List<Object> binds = ps.binds();
                for (int i = 0; i < binds.size(); i++) {
                    st.setObject(i + 1, binds.get(i));
                }
                try (ResultSet rs = st.executeQuery()) {
                    RenderResult result = switch (format) {
                        case "xlsx" -> exportXlsx(req, rs);
                        case "pdf" -> exportPdf(req, rs);
                        default -> exportCsv(req, rs); // csv (and anything unrecognised) -> csv
                    };
                    log.info("Query-export {} [{}] in {} ms ({} bytes)",
                            safe(req.code()), format, System.currentTimeMillis() - t0, result.sizeBytes());
                    return result;
                }
            }
        } catch (RenderException re) {
            throw re;
        } catch (Exception e) {
            throw new RenderException("Query export failed: " + e.getMessage(), e);
        } finally {
            if (conn != null) {
                try { conn.close(); } catch (Exception ignore) { }
            }
        }
    }

    private Connection primaryConnection() throws Exception {
        var ds = jdbcTemplate.getDataSource();
        if (ds == null) {
            throw new RenderException("No datasource configured for the query-export engine");
        }
        return ds.getConnection();
    }

    /** Stream a result set to a UTF-8 CSV temp file (BOM so Excel reads Thai); never buffers rows. */
    private RenderResult exportCsv(RenderRequest req, ResultSet rs) throws Exception {
        ResultSetMetaData meta = rs.getMetaData();
        int n = meta.getColumnCount();
        Path tmp = Files.createTempFile("rs-export-", ".csv");
        try {
            try (OutputStream os = Files.newOutputStream(tmp);
                 BufferedWriter w = new BufferedWriter(new OutputStreamWriter(os, StandardCharsets.UTF_8), 1 << 16)) {
                w.write('﻿'); // UTF-8 BOM so Excel opens Thai text correctly
                for (int i = 1; i <= n; i++) {
                    if (i > 1) w.write(',');
                    w.write(csvEscape(columnLabel(meta, i)));
                }
                w.write("\r\n");
                while (rs.next()) {
                    for (int i = 1; i <= n; i++) {
                        if (i > 1) w.write(',');
                        w.write(csvEscape(stringifyCell(rs.getObject(i))));
                    }
                    w.write("\r\n");
                }
            }
            return RenderResult.ofFile(tmp, "text/csv; charset=UTF-8", "csv", Files.size(tmp));
        } catch (Exception e) {
            // A mid-stream JDBC/disk failure must not orphan a partial temp file on the pod.
            try { Files.deleteIfExists(tmp); } catch (Exception ignore) { }
            throw e;
        }
    }

    /** Stream a result set to an XLSX temp file via SXSSF; spill into extra sheets past Excel's cap. */
    private RenderResult exportXlsx(RenderRequest req, ResultSet rs) throws Exception {
        ResultSetMetaData meta = rs.getMetaData();
        int n = meta.getColumnCount();
        String[] headers = new String[n];
        for (int i = 1; i <= n; i++) {
            headers[i - 1] = columnLabel(meta, i);
        }

        Path tmp = Files.createTempFile("rs-export-", ".xlsx");
        boolean ok = false;
        SXSSFWorkbook wb = new SXSSFWorkbook(SXSSF_WINDOW);
        wb.setCompressTempFiles(true);
        try (OutputStream os = Files.newOutputStream(tmp)) {
            CellStyle headerStyle = wb.createCellStyle();
            Font headerFont = wb.createFont();
            headerFont.setBold(true);
            headerStyle.setFont(headerFont);
            headerStyle.setFillForegroundColor(IndexedColors.GREY_25_PERCENT.getIndex());
            headerStyle.setFillPattern(FillPatternType.SOLID_FOREGROUND);

            CellStyle cellStyle = wb.createCellStyle();
            CellStyle numStyle = wb.createCellStyle();
            numStyle.setDataFormat(wb.createDataFormat().getFormat("#,##0.######"));
            numStyle.setAlignment(HorizontalAlignment.RIGHT);

            int sheetNo = 1;
            Sheet sheet = wb.createSheet("Report");
            writeXlsxHeader(sheet, headers, headerStyle);
            long rowsInSheet = 0;
            int xlRow = 1; // row 0 holds the header
            while (rs.next()) {
                if (rowsInSheet >= XLSX_MAX_DATA_ROWS_PER_SHEET) {
                    sheetNo++;
                    sheet = wb.createSheet("Report_" + sheetNo);
                    writeXlsxHeader(sheet, headers, headerStyle);
                    xlRow = 1;
                    rowsInSheet = 0;
                }
                Row row = sheet.createRow(xlRow++);
                for (int i = 1; i <= n; i++) {
                    Cell cell = row.createCell(i - 1);
                    writeNumberOrString(cell, rs.getObject(i), numStyle, cellStyle);
                }
                rowsInSheet++;
            }
            wb.write(os);
            ok = true;
        } finally {
            wb.dispose(); // delete SXSSF's own temp files
            // A mid-stream failure must not orphan a partial temp file on the pod.
            if (!ok) { try { Files.deleteIfExists(tmp); } catch (Exception ignore) { } }
        }
        try {
            return RenderResult.ofFile(tmp,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx", Files.size(tmp));
        } catch (Exception e) {
            // Files.size on the just-written file can (rarely) throw — keep symmetric with exportCsv and
            // delete the temp file rather than orphaning it on the pod.
            try { Files.deleteIfExists(tmp); } catch (Exception ignore) { }
            throw e;
        }
    }

    /** Build a bounded PDF from the first {@value #QUERY_PDF_MAX_ROWS} rows (PDF can't hold bulk extracts). */
    private RenderResult exportPdf(RenderRequest req, ResultSet rs) throws Exception {
        ResultSetMetaData meta = rs.getMetaData();
        int n = meta.getColumnCount();
        List<String> cols = new ArrayList<>(n);
        for (int i = 1; i <= n; i++) {
            cols.add(columnLabel(meta, i));
        }
        TabularData data = new TabularData(cols);
        int count = 0;
        boolean truncated = false;
        while (rs.next()) {
            if (count >= QUERY_PDF_MAX_ROWS) { truncated = true; break; }
            List<String> cells = new ArrayList<>(n);
            for (int i = 1; i <= n; i++) {
                cells.add(stringifyCell(rs.getObject(i)));
            }
            data.addRow(cells);
            count++;
        }
        if (truncated) {
            log.warn("Query-export PDF for {} truncated to {} rows — use CSV/XLSX for full extracts",
                    safe(req.code()), QUERY_PDF_MAX_ROWS);
        }
        byte[] pdf = renderGenericPdf(req, data);
        return new RenderResult(pdf, "application/pdf", "pdf", pdf.length);
    }

    private static void writeXlsxHeader(Sheet sheet, String[] headers, CellStyle headerStyle) {
        Row hr = sheet.createRow(0);
        for (int c = 0; c < headers.length; c++) {
            Cell cell = hr.createCell(c);
            cell.setCellValue(headers[c]);
            cell.setCellStyle(headerStyle);
        }
    }

    /** Write a real Excel number when it round-trips safely; otherwise a string (keeps big IDs exact). */
    private static void writeNumberOrString(Cell cell, Object obj, CellStyle numStyle, CellStyle cellStyle) {
        if (obj == null) {
            cell.setCellStyle(cellStyle);
            return;
        }
        Double d = numericOrNull(obj);
        if (d != null) {
            cell.setCellValue(d);
            cell.setCellStyle(numStyle);
        } else {
            cell.setCellValue(stringifyCell(obj));
            cell.setCellStyle(cellStyle);
        }
    }

    private static Double numericOrNull(Object obj) {
        if (obj instanceof BigDecimal bd) {
            return bd.precision() <= 15 ? bd.doubleValue() : null; // avoid precision loss on long IDs
        }
        if (obj instanceof Double || obj instanceof Float) {
            return ((Number) obj).doubleValue();
        }
        if (obj instanceof Long || obj instanceof Integer || obj instanceof Short || obj instanceof Byte) {
            long l = ((Number) obj).longValue();
            return Math.abs(l) < 1_000_000_000_000_000L ? (double) l : null;
        }
        return null;
    }

    private static String columnLabel(ResultSetMetaData meta, int i) throws Exception {
        String label = meta.getColumnLabel(i);
        return (label == null || label.isBlank()) ? meta.getColumnName(i) : label;
    }

    /** Convert Jasper-style placeholders: {@code $P{name}} -> bound '?'; {@code $P!{name}} -> inlined literal. */
    private PreparedSql prepareSql(String raw, Map<String, Object> params) {
        Map<String, Object> p = params == null ? Map.of() : params;
        StringBuilder out = new StringBuilder(raw.length() + 16);
        List<Object> binds = new ArrayList<>();
        Matcher m = P_PLACEHOLDER.matcher(raw);
        int last = 0;
        while (m.find()) {
            out.append(raw, last, m.start());
            boolean noBind = "!".equals(m.group(1));
            Object val = p.get(m.group(2));
            if (noBind) {
                out.append(val == null ? "" : val.toString()); // dynamic SQL fragment (admin-defined report)
            } else {
                out.append('?');
                binds.add(val);
            }
            last = m.end();
        }
        out.append(raw, last, raw.length());
        return new PreparedSql(out.toString(), binds);
    }

    private record PreparedSql(String sql, List<Object> binds) { }

    /** Fixed sample region/amount dataset so PDF/XLSX/CSV always have content (no SQL). */
    private static TabularData sampleData() {
        TabularData data = new TabularData(List.of("Seq", "Region", "Amount (THB)"));
        String[][] sample = {
                {"Central", "330125400000"},
                {"North", "316948200000"},
                {"Northeast", "285470000000"},
                {"South", "198562000000"},
                {"East", "165433000000"},
                {"West", "142870000000"},
                {"Bangkok", "117320000000"},
                {"Greater Bangkok", "127340000000"},
                {"Lower North", "54210000000"},
                {"Upper South", "25640000000"},
        };
        int seq = 1;
        for (String[] row : sample) {
            data.addRow(List.of(String.valueOf(seq++), row[0], row[1]));
        }
        return data;
    }

    /** True when the data looks like the canonical seq/region/amount fact table. */
    private static boolean isFactShape(TabularData data) {
        if (data.columnCount() != 3) {
            return false;
        }
        // Last column must be numeric for every row (the amount).
        for (List<String> row : data.rows()) {
            if (asNumber(row.get(2)) == null) {
                return false;
            }
        }
        return true;
    }

    /** Map canonical 3-column data to FactRow beans for the JRXML template. */
    private static List<FactRow> toFactRows(TabularData data) {
        List<FactRow> beans = new ArrayList<>();
        int seq = 1;
        for (List<String> row : data.rows()) {
            Double amt = asNumber(row.get(2));
            beans.add(new FactRow(seq++, row.get(1), amt == null ? 0d : amt));
        }
        if (beans.isEmpty()) {
            beans.add(new FactRow(1, "-", 0d));
        }
        return beans;
    }

    // ------------------------------------------------------------------------
    // Jasper design helpers (programmatic generic report)
    // ------------------------------------------------------------------------

    private static JRDesignStaticText centeredStatic(String text, int y, int width, int height,
                                                     int fontSize, boolean bold) {
        JRDesignStaticText st = new JRDesignStaticText();
        st.setX(0);
        st.setY(y);
        st.setWidth(width);
        st.setHeight(height);
        st.setText(text == null ? "" : text);
        st.setHorizontalTextAlign(HorizontalTextAlignEnum.CENTER);
        st.setFontSize((float) fontSize);
        st.setBold(bold);
        return st;
    }

    private static JRDesignStaticText boxedStatic(String text, int x, int width, int height, boolean bold) {
        JRDesignStaticText st = new JRDesignStaticText();
        st.setX(x);
        st.setY(0);
        st.setWidth(width);
        st.setHeight(height);
        st.setText(text == null ? "" : text);
        st.setFontSize(9f);
        st.setBold(bold);
        box(st);
        return st;
    }

    private static void box(net.sf.jasperreports.engine.JRBoxContainer el) {
        el.getLineBox().getPen().setLineWidth(0.5f);
    }

    // ------------------------------------------------------------------------
    // Misc helpers
    // ------------------------------------------------------------------------

    private static String normalizeFormat(String fmt) {
        if (!hasText(fmt)) {
            return "pdf";
        }
        return fmt.trim().toLowerCase(Locale.ROOT);
    }

    private static Double asNumber(String v) {
        if (v == null || v.isBlank()) {
            return null;
        }
        String cleaned = v.replace(",", "").trim();
        try {
            return Double.parseDouble(cleaned);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static boolean hasText(String s) {
        return s != null && !s.isBlank();
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }

    private static String safe(String s, String fallback) {
        return hasText(s) ? s : fallback;
    }
}
