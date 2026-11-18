package io.reporthub.reportstudio.web;

import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.domain.OutputFile;
import io.reporthub.reportstudio.domain.OutputReview;
import io.reporthub.reportstudio.domain.Report;
import io.reporthub.reportstudio.repo.OutputFileRepository;
import io.reporthub.reportstudio.repo.OutputReviewRepository;
import io.reporthub.reportstudio.repo.ReportRepository;
import io.reporthub.reportstudio.storage.ObjectStorageService;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Generated report outputs persisted in object storage (MinIO).
 *
 * <ul>
 *   <li>{@code GET /outputs}                        — list output files, newest first</li>
 *   <li>{@code GET /outputs/{objectKey}/download}   — stream the stored bytes back</li>
 *   <li>{@code GET /jobs/{jobId}/output/download}   — stream a run's output straight from its jobId</li>
 * </ul>
 *
 * <p>The store is a single shared bucket with no per-object ACL, so access is scoped
 * here in the controller. {@link io.reporthub.reportstudio.security.SecurityConfig} requires
 * every request to be authenticated ({@code anyRequest().authenticated()}); on top of that:
 * <ul>
 *   <li>report-run outputs (those carrying a {@code jobId}) are shared across the signed-in
 *       team — any authenticated user may list and download them;</li>
 *   <li>analytics / saved-view exports ({@code jobId} is null) are scoped to their creator,
 *       so a caller only sees and downloads their own;</li>
 *   <li>an {@code ADMIN} may list and download everything.</li>
 * </ul>
 */
@RestController
public class OutputController {

    /** {@code createdBy} markers that never belong to a real account and so are never caller-owned. */
    private static final String PUBLIC = "public";
    private static final String ANONYMOUS = "anonymous";

    private final OutputFileRepository outputs;
    private final ObjectStorageService storage;
    private final ReportRepository reports;
    private final OutputReviewRepository reviews;
    /** Report categories — the Output Files screen groups its top-level folders by category. */
    private final io.reporthub.reportstudio.repo.ReportCategoryRepository categories;

    /**
     * Base URL of the notification service; blank disables e-mail sharing (the endpoint replies
     * that it is not configured). Set via env APP_NOTIFY_BASE_URL, e.g.
     * {@code https://notify.example.com}
     */
    private final String notifyBaseUrl;

    /** Origin of links sent out by e-mail — recipients are outside the cluster, so this must be a public URL. */
    private final String publicBase;

    /** Connection holding the USERS directory table — maps recipient e-mails to USER_IDs for in-app notifications. */
    private final String directoryDatasourceId;

    /** Used to look up user ids by e-mail — the same connection the screens read data from. */
    private final io.reporthub.reportstudio.service.DbConnections db;

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(OutputController.class);

    public OutputController(OutputFileRepository outputs, ObjectStorageService storage,
                            ReportRepository reports, OutputReviewRepository reviews,
                            io.reporthub.reportstudio.repo.ReportCategoryRepository categories,
                            io.reporthub.reportstudio.service.DbConnections db,
                            @org.springframework.beans.factory.annotation.Value("${app.notify.base-url:}") String notifyBaseUrl,
                            @org.springframework.beans.factory.annotation.Value("${app.public-base-url:}") String publicBase,
                            @org.springframework.beans.factory.annotation.Value("${app.directory.datasource-id:directory}") String directoryDatasourceId) {
        this.outputs = outputs;
        this.storage = storage;
        this.reports = reports;
        this.reviews = reviews;
        this.categories = categories;
        this.db = db;
        this.notifyBaseUrl = notifyBaseUrl == null ? "" : notifyBaseUrl.trim().replaceAll("/+$", "");
        this.publicBase = publicBase == null ? "" : publicBase.trim().replaceAll("/+$", "");
        this.directoryDatasourceId = directoryDatasourceId == null || directoryDatasourceId.isBlank() ? "directory" : directoryDatasourceId.trim();
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.integration.ConnectorStore connectors;

    /** Notification-service e-mail template used for "share by e-mail" (app.notify.email-template). */
    @org.springframework.beans.factory.annotation.Value("${app.notify.email-template:report-share}")
    private String emailTemplateCode = "report-share";
    /** Notification-service in-app notification config code (app.notify.in-app-config). */
    @org.springframework.beans.factory.annotation.Value("${app.notify.in-app-config:report-share}")
    private String inAppConfigCode = "report-share";
    /**
     * User-directory lookups (app.directory.*). The display-name query takes the login twice
     * (username, e-mail); the user-id query gets {@code {emails}} expanded to bind markers.
     */
    @org.springframework.beans.factory.annotation.Value("${app.directory.display-name-sql:SELECT TRIM(COALESCE(FIRST_NAME,'') || ' ' || COALESCE(LAST_NAME,'')) FROM USERS WHERE LOWER(USER_NAME) = ? OR LOWER(EMAIL) = ?}")
    private String displayNameSql = "SELECT TRIM(COALESCE(FIRST_NAME,'') || ' ' || COALESCE(LAST_NAME,'')) FROM USERS WHERE LOWER(USER_NAME) = ? OR LOWER(EMAIL) = ?";
    @org.springframework.beans.factory.annotation.Value("${app.directory.user-ids-sql:SELECT USER_ID FROM USERS WHERE LOWER(EMAIL) IN ({emails})}")
    private String userIdsSql = "SELECT USER_ID FROM USERS WHERE LOWER(EMAIL) IN ({emails})";
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.integration.FileHubService fileHub;

    /** Notification service URL: Integrations → Notifications, else APP_NOTIFY_BASE_URL. */
    private String notifyBaseUrl() {
        String v = connectors == null ? "" : connectors.find("notify").map(r -> r.str("baseUrl")).orElse("");
        return v.isEmpty() ? notifyBaseUrl : v.replaceAll("/+$", "");
    }

    public record FileHubPublishRequest(String connectorId, List<String> keys) {}
    public record FileHubDto(String connectorId, String fileId, String url, OffsetDateTime publishedAt) {}
    public record FileHubBulkResult(String objectKey, boolean ok, FileHubDto filehub, String error) {}

    /** Publish one output to FileHub ({@code ?key=objectKey}); records the FileHub id + link on it. */
    @PostMapping("/outputs/filehub")
    public FileHubDto publishToFileHub(@org.springframework.web.bind.annotation.RequestParam("key") String objectKey,
                                       @RequestBody(required = false) FileHubPublishRequest req, Authentication auth) {
        if (fileHub == null) throw new BadRequestException("FileHub integration is not available");
        OutputFile out = outputs.findByObjectKey(objectKey)
                .orElseThrow(() -> new NotFoundException("Output not found: " + objectKey));
        if (!canAccess(out, auth)) throw new NotFoundException("Output not found: " + objectKey);
        try {
            fileHub.publishOutput(out, req == null ? null : req.connectorId(), downloadFilename(out), contentTypeFor(out.getFmt()).toString());
        } catch (io.reporthub.reportstudio.integration.FileHubClient.FileHubException e) {
            throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.BAD_GATEWAY, e.getMessage());
        }
        return fileHubDto(out);
    }

    /** Publish several outputs; each one reports its own result. */
    @PostMapping("/outputs/filehub/bulk")
    public List<FileHubBulkResult> publishToFileHubBulk(@RequestBody FileHubPublishRequest req, Authentication auth) {
        if (req == null || req.keys() == null || req.keys().isEmpty()) throw new BadRequestException("No outputs selected");
        if (req.keys().size() > 200) throw new BadRequestException("At most 200 outputs at a time");
        List<FileHubBulkResult> res = new java.util.ArrayList<>();
        for (String k : req.keys()) {
            try {
                res.add(new FileHubBulkResult(k, true, publishToFileHub(k, req, auth), null));
            } catch (Exception e) {
                res.add(new FileHubBulkResult(k, false, null, e instanceof org.springframework.web.server.ResponseStatusException r ? r.getReason() : e.getMessage()));
            }
        }
        return res;
    }

    private static FileHubDto fileHubDto(OutputFile o) {
        return o.getFilehubFileId() == null ? null
                : new FileHubDto(o.getFilehubConnectorId(), o.getFilehubFileId(), o.getFilehubUrl(), o.getFilehubPublishedAt());
    }

    /** Path of a share link relative to the API base (context path not included). */
    static String sharePath(String token) { return "/public/share/" + token; }

    /**
     * Absolute API base used in share links: {@code app.public-base-url} (env APP_PUBLIC_BASE_URL,
     * e.g. {@code https://host/reportstudio/api}) when set, else the current request's scheme, host
     * and context path.
     */
    private String publicBaseUrl() {
        if (!publicBase.isEmpty()) return publicBase;
        try {
            return org.springframework.web.servlet.support.ServletUriComponentsBuilder
                    .fromCurrentContextPath().build().toUriString().replaceAll("/+$", "");
        } catch (IllegalStateException noRequest) {
            return "";
        }
    }

    /**
     * List output files visible to the caller, newest first: team-visible report-run outputs
     * plus the caller's own analytics exports. An {@code ADMIN} sees every output.
     */
    @GetMapping("/outputs")
    public List<OutputFileDto> list(Authentication auth) {
        List<OutputFile> rows = isAdmin(auth)
                ? outputs.findAllByOrderByCreatedAtDesc()
                : outputFilter(outputs.findVisibleTo(auth.getName()), OutputFile::getReportCode);
        // Resolve report codes -> names in one pass so the Output screen can show both
        // the report name and its code (the object key only carries the code).
        List<Report> allReports = reports.findAll();
        Map<String, String> names = allReports.stream()
                .collect(Collectors.toMap(Report::getCode, Report::getName, (a, b) -> a));
        // Report code -> category name, so the screen can group top-level folders by category
        // without fetching the whole report registry to map it client-side.
        Map<String, String> catName = categories.findAll().stream()
                .collect(Collectors.toMap(io.reporthub.reportstudio.domain.ReportCategory::getId,
                        io.reporthub.reportstudio.domain.ReportCategory::getName, (a, b) -> a));
        Map<String, String> catOfCode = allReports.stream()
                .filter(r -> r.getCategoryId() != null && catName.containsKey(r.getCategoryId()))
                .collect(Collectors.toMap(Report::getCode, r -> catName.get(r.getCategoryId()), (a, b) -> a));
        // Fetch the reviews for this page's files in one query, not one per row.
        Map<String, OutputReview> confirmed = reviews
                .findByObjectKeyIn(rows.stream().map(OutputFile::getObjectKey).toList())
                .stream()
                .collect(Collectors.toMap(OutputReview::getObjectKey, r -> r, (a, b) -> a));
        return rows.stream()
                .map(o -> toDto(o, names.get(o.getReportCode()), catOfCode.get(o.getReportCode()),
                        confirmed.get(o.getObjectKey())))
                .toList();
    }

    /**
     * Folder sidebar of the Output Files screen — one row per report that has output files.
     *
     * <p>Previously the screen pulled the whole {@code GET /outputs} list and counted client-side,
     * which was noticeably slow on large stores. This aggregates in the database and returns at
     * most one row per report that has ever produced output.
     */
    @GetMapping("/outputs/tree")
    public List<OutputTreeRow> tree(Authentication auth) {
        String scope = isAdmin(auth) ? null : auth.getName();
        Map<String, String> names = new java.util.HashMap<>();
        Map<String, String> cats = new java.util.HashMap<>();
        Map<String, String> catName = categories.findAll().stream()
                .collect(Collectors.toMap(io.reporthub.reportstudio.domain.ReportCategory::getId,
                        io.reporthub.reportstudio.domain.ReportCategory::getName, (a, b) -> a));
        for (Report r : reports.findAll()) {
            names.put(r.getCode(), r.getName());
            String c = r.getCategoryId() == null ? null : catName.get(r.getCategoryId());
            if (c != null) cats.put(r.getCode(), c);
        }
        return outputFilter(outputs.summarise(scope), row -> (String) row[0]).stream()
                .map(row -> new OutputTreeRow(
                        (String) row[0],
                        names.get((String) row[0]),
                        cats.get((String) row[0]),
                        ((Number) row[1]).longValue(),
                        ((Number) row[2]).longValue(),
                        (OffsetDateTime) row[3]))
                .toList();
    }

    /**
     * One page of output files, newest first.
     *
     * <p>{@code report} = comma-separated report codes (one when a report is selected, all of a
     * category's reports when a category is selected — categories live in the report registry,
     * not the output table). Omitted = all reports. {@code q} = search term on object key / report code.
     */
    @GetMapping("/outputs/page")
    public OutputPage page(@RequestParam(required = false) String report,
                           @RequestParam(required = false) String q,
                           @RequestParam(defaultValue = "100") int limit,
                           @RequestParam(defaultValue = "0") int offset,
                           Authentication auth) {
        String scope = isAdmin(auth) ? null : auth.getName();
        List<String> codes = report == null || report.isBlank() ? null
                : java.util.Arrays.stream(report.split(",")).map(String::trim).filter(t -> !t.isEmpty()).toList();
        if (codes != null && codes.isEmpty()) codes = null;
        String needle = q == null || q.isBlank() ? null : "%" + q.trim().toLowerCase() + "%";
        int size = Math.min(Math.max(limit, 1), 500);
        var pageable = org.springframework.data.domain.PageRequest.of(offset / size, size);

        List<OutputFile> rows = outputs.page(scope, codes, needle, pageable);
        if (scope != null) rows = outputFilter(rows, OutputFile::getReportCode);
        long total = outputs.countPage(scope, codes, needle);
        List<Report> allReports = reports.findAll();
        Map<String, String> names = allReports.stream()
                .collect(Collectors.toMap(Report::getCode, Report::getName, (a, b) -> a));
        Map<String, String> catName = categories.findAll().stream()
                .collect(Collectors.toMap(io.reporthub.reportstudio.domain.ReportCategory::getId,
                        io.reporthub.reportstudio.domain.ReportCategory::getName, (a, b) -> a));
        Map<String, String> catOfCode = allReports.stream()
                .filter(r -> r.getCategoryId() != null && catName.containsKey(r.getCategoryId()))
                .collect(Collectors.toMap(Report::getCode, r -> catName.get(r.getCategoryId()), (a, b) -> a));
        Map<String, OutputReview> confirmed = reviews
                .findByObjectKeyIn(rows.stream().map(OutputFile::getObjectKey).toList())
                .stream()
                .collect(Collectors.toMap(OutputReview::getObjectKey, r -> r, (a, b) -> a));
        List<OutputFileDto> items = rows.stream()
                .map(o -> toDto(o, names.get(o.getReportCode()), catOfCode.get(o.getReportCode()),
                        confirmed.get(o.getObjectKey())))
                .toList();
        return new OutputPage(items, total);
    }

    /**
     * Confirm that this file has been reviewed.
     *
     * <p>Idempotent — re-confirming overwrites the reviewer, time and note, since a reviewer may
     * click twice or change the note; that is not an error.
     */
    @PostMapping("/outputs/confirm")
    public ReviewDto confirm(@RequestBody ConfirmRequest body, Authentication auth) {
        String key = body == null ? null : body.objectKey();
        if (key == null || key.isBlank()) {
            throw new BadRequestException("objectKey is required");
        }
        OutputFile out = outputs.findByObjectKey(key)
                .orElseThrow(() -> new NotFoundException("No such output file: " + key));
        if (!canAccess(out, auth)) {
            throw new NotFoundException("No such output file: " + key);
        }
        OutputReview r = reviews.findById(key).orElseGet(OutputReview::new);
        r.setObjectKey(key);
        r.setReportCode(out.getReportCode());
        r.setConfirmedBy(auth == null ? "console" : auth.getName());
        r.setConfirmedAt(OffsetDateTime.now());
        String note = body.note();
        r.setNote(note == null || note.isBlank() ? null : note.trim());
        reviews.save(r);
        return new ReviewDto(r.getConfirmedBy(), r.getConfirmedAt(), r.getNote());
    }

    /** Withdraw a review confirmation — lets a reviewer undo a mistaken click. */
    @DeleteMapping("/outputs/confirm")
    public void unconfirm(@org.springframework.web.bind.annotation.RequestParam("key") String key,
                          Authentication auth) {
        OutputFile out = outputs.findByObjectKey(key)
                .orElseThrow(() -> new NotFoundException("No such output file: " + key));
        if (!canAccess(out, auth)) {
            throw new NotFoundException("No such output file: " + key);
        }
        reviews.deleteById(key);
    }

    /** Slash-safe download (folder paths in the key). */
    @GetMapping("/outputs/download")
    public ResponseEntity<byte[]> downloadByKey(@org.springframework.web.bind.annotation.RequestParam("key") String key,
                                                Authentication auth) {
        return download(key, auth);
    }

    /**
     * Convenience download straight from a jobId — an external caller can go from
     * {@code POST /reports/{code}/run} (returns {@code jobId}) to the finished file without
     * listing {@code /outputs} and matching by hand. Returns the newest output for the job;
     * a multi-unit report can produce several files, so use {@code GET /outputs} to enumerate
     * them all. 404 while the job is still running / failed / produced no file.
     */
    @GetMapping("/jobs/{jobId}/output/download")
    public ResponseEntity<byte[]> downloadByJob(@PathVariable String jobId, Authentication auth) {
        OutputFile out = outputs.findByJobIdOrderByCreatedAtDesc(jobId).stream().findFirst()
                .orElseThrow(() -> new NotFoundException(
                        "No output for job: " + jobId + " (still running, failed, or produced no file)"));
        if (!canAccess(out, auth)) {
            throw new NotFoundException("No output for job: " + jobId);
        }
        byte[] body = storage.get(out.getObjectKey());
        ContentDisposition cd = ContentDisposition.attachment().filename(downloadFilename(out),
                java.nio.charset.StandardCharsets.UTF_8).build();
        return ResponseEntity.ok()
                .contentType(contentTypeFor(out.getFmt()))
                .header(HttpHeaders.CONTENT_DISPOSITION, cd.toString())
                .body(body);
    }

    // ---- Share a file by link ------------------------------------------------------------

    public record ShareRequest(
            /** Link lifetime in days; null or <= 0 = never expires. */
            Integer days) {}

    /**
     * @param url  absolute link (public base URL + path) to hand to people
     * @param path link relative to the API base, e.g. {@code /public/share/<token>}
     */
    public record ShareDto(String token, String url, String path, OffsetDateTime expiresAt,
                           String sharedBy, OffsetDateTime sharedAt, int hits) {}

    /**
     * Create (or re-issue) the share link for this file.
     *
     * The token is 32 bytes from {@link java.security.SecureRandom}, base64url-encoded, so it
     * cannot be guessed — the link opens <b>without login</b>, so the token is the only guard.
     * Calling again issues a new token and the old link stops working immediately (intentional:
     * this is how a leaked link is rotated).
     */
    // objectKey contains '/' (e.g. "RPT-001/RPT-001_default_….xlsx"). As a @PathVariable it would be
    // encoded as %2F, which Tomcat rejects with 400 before reaching the app (ALLOW_ENCODED_SLASH is
    // off) — the download endpoint works around it the same way, so the key is a query param.
    @PostMapping("/outputs/share")
    public ShareDto share(@org.springframework.web.bind.annotation.RequestParam("key") String objectKey,
                          @RequestBody(required = false) ShareRequest req,
                          Authentication auth) {
        OutputFile out = outputs.findByObjectKey(objectKey)
                .orElseThrow(() -> new NotFoundException("Output not found: " + objectKey));
        if (!canAccess(out, auth)) throw new NotFoundException("Output not found: " + objectKey);

        byte[] raw = new byte[32];
        new java.security.SecureRandom().nextBytes(raw);
        out.setShareToken(java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(raw));
        Integer days = req == null ? null : req.days();
        out.setShareExpiresAt(days == null || days <= 0 ? null : OffsetDateTime.now().plusDays(days));
        out.setSharedBy(auth == null ? "anonymous" : auth.getName());
        out.setSharedAt(OffsetDateTime.now());
        out.setShareHits(0);
        outputs.save(out);
        return shareDto(out);
    }

    /** Revoke sharing — the existing link stops working immediately. */
    @DeleteMapping("/outputs/share")
    public void unshare(@org.springframework.web.bind.annotation.RequestParam("key") String objectKey,
                        Authentication auth) {
        OutputFile out = outputs.findByObjectKey(objectKey)
                .orElseThrow(() -> new NotFoundException("Output not found: " + objectKey));
        if (!canAccess(out, auth)) throw new NotFoundException("Output not found: " + objectKey);
        out.setShareToken(null);
        out.setShareExpiresAt(null);
        outputs.save(out);
    }

    /**
     * Open a file from its share link — <b>no login required</b> (under /public/**, which
     * SecurityConfig permits).
     *
     * Every failure (unknown token / expired / revoked) returns the same 404; distinct messages
     * would tell someone guessing tokens which ones once existed.
     */
    @GetMapping("/public/share/{token}")
    public ResponseEntity<byte[]> openShared(@PathVariable String token,
            @org.springframework.web.bind.annotation.RequestHeader(value = HttpHeaders.ACCEPT, required = false) String accept) {
        OutputFile out = outputs.findByShareToken(token)
                .filter(o -> o.getShareExpiresAt() == null || o.getShareExpiresAt().isAfter(OffsetDateTime.now()))
                .orElse(null);
        if (out == null) {
            // Browsers get a small readable page instead of raw JSON; API clients keep the JSON 404.
            if (accept != null && accept.contains("text/html")) {
                String html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
                        + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                        + "<title>Link not available</title></head>"
                        + "<body style=\"font-family:system-ui,sans-serif;margin:0;padding:48px 16px;color:#161616\">"
                        + "<h1 style=\"font-size:20px;font-weight:600;margin:0 0 8px\">This link is no longer valid</h1>"
                        + "<p style=\"margin:0;color:#525252\">It may have expired or been revoked. Ask the sender for a new link.</p>"
                        + "</body></html>";
                return ResponseEntity.status(org.springframework.http.HttpStatus.NOT_FOUND)
                        .contentType(new MediaType("text", "html", java.nio.charset.StandardCharsets.UTF_8))
                        .body(html.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            throw new NotFoundException("This link is no longer valid");
        }
        out.setShareHits(out.getShareHits() + 1);
        outputs.save(out);
        byte[] body = storage.get(out.getObjectKey());
        // inline = view in the browser rather than forcing a download — most recipients just want to look.
        ContentDisposition cd = ContentDisposition.inline().filename(downloadFilename(out),
                java.nio.charset.StandardCharsets.UTF_8).build();
        return ResponseEntity.ok()
                .contentType(contentTypeFor(out.getFmt()))
                .header(HttpHeaders.CONTENT_DISPOSITION, cd.toString())
                .body(body);
    }

    // ---- Send a link by e-mail -------------------------------------------------------------
    //
    // Sending is user-initiated, never automatic on render completion: the system produces
    // thousands of files a day and auto-mailing them would be spam. The button lives on the file
    // detail view.

    public record EmailShareRequest(String to, String cc, String note, Integer days) {}

    /** @param notifiedOnScreen number of recipients who are system users and so also got an in-app notification */
    public record EmailShareResult(String to, String url, OffsetDateTime expiresAt, int notifiedOnScreen) {}

    /**
     * Full name of the sender. Portal users log in with an e-mail while local accounts use a
     * username, so both are matched. Not found (or the database is down) returns the login —
     * the e-mail must always go out.
     */
    private String displayName(String login) {
        if (login == null || login.isBlank()) return "System";
        try {
            return db.withConnection(directoryDatasourceId, true, (con) -> {
                String sql = displayNameSql;
                try (java.sql.PreparedStatement ps = con.prepareStatement(sql)) {
                    String k = login.toLowerCase(java.util.Locale.ROOT);
                    ps.setString(1, k);
                    ps.setString(2, k);
                    try (java.sql.ResultSet rs = ps.executeQuery()) {
                        if (rs.next()) {
                            String n = rs.getString(1);
                            if (n != null && !n.isBlank()) return n;
                        }
                    }
                    return login;
                }
            });
        } catch (Exception e) {
            log.warn("Could not resolve sender name from the user directory, using login instead: {}", e.getMessage());
            return login;
        }
    }

    /**
     * Resolve user ids from the e-mails the user typed; addresses not found are external
     * recipients and are skipped. Uses the configured directory connection.
     */
    private List<String> lookupUserIds(String toList) {
        List<String> emails = java.util.Arrays.stream(toList.split("[,;]"))
                .map(String::trim).filter(e -> !e.isEmpty()).map(e -> e.toLowerCase(java.util.Locale.ROOT))
                .distinct().toList();
        if (emails.isEmpty()) return List.of();
        try {
            // Never pass null: null means Report Studio's own PostgreSQL database, which has no
            // user directory table ("relation ... does not exist"). Use the directory connection.
            return db.withConnection(directoryDatasourceId, true, (con) -> {
                String marks = String.join(",", java.util.Collections.nCopies(emails.size(), "?"));
                String sql = userIdsSql.replace("{emails}", marks);
                try (java.sql.PreparedStatement ps = con.prepareStatement(sql)) {
                    for (int i = 0; i < emails.size(); i++) ps.setString(i + 1, emails.get(i));
                    List<String> ids = new java.util.ArrayList<>();
                    try (java.sql.ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) { String v = rs.getString(1); if (v != null && !v.isBlank()) ids.add(v); }
                    }
                    return ids;
                }
            });
        } catch (Exception e) {
            // Lookup failure = no in-app notification, but the e-mail must still go out.
            log.warn("Could not resolve USER_IDs from e-mails: {}", e.getMessage());
            return List.of();
        }
    }

    /**
     * E-mail this file's download link via the notification service.
     *
     * If the file has not been shared yet a link is issued automatically (default 30 days), so
     * external recipients can open it without logging in.
     *
     * Note: the notification service's endpoints sit under {@code /api} (the controller has a
     * class-level @RequestMapping("/api")).
     */
    @PostMapping("/outputs/share/email")
    public EmailShareResult emailShare(@org.springframework.web.bind.annotation.RequestParam("key") String objectKey,
                                       @RequestBody EmailShareRequest req, Authentication auth) {
        String notifyBaseUrl = notifyBaseUrl();
        if (notifyBaseUrl == null || notifyBaseUrl.isBlank()) {
            throw new BadRequestException("Notification service URL is not configured (APP_NOTIFY_BASE_URL)");
        }
        if (req == null || req.to() == null || req.to().isBlank()) {
            throw new BadRequestException("At least one recipient e-mail is required");
        }
        OutputFile out = outputs.findByObjectKey(objectKey)
                .orElseThrow(() -> new NotFoundException("Output not found: " + objectKey));
        if (!canAccess(out, auth)) throw new NotFoundException("Output not found: " + objectKey);

        // Not shared yet = issue a link now, otherwise the e-mail has nothing to click.
        if (out.getShareToken() == null) {
            share(objectKey, new ShareRequest(req.days() == null ? 30 : req.days()), auth);
            out = outputs.findByObjectKey(objectKey).orElseThrow();
        }
        String url = publicBaseUrl() + sharePath(out.getShareToken());

        Report r = reports.findByCode(out.getReportCode()).orElse(null);
        String title = r != null && r.getName() != null ? r.getName() : out.getReportCode();
        // Sender name shown in the e-mail — auth.getName() is the login (e.g. "test"), not a person's
        // name, so look up the real name in the user directory and fall back to the login.
        String login = auth == null ? null : auth.getName();
        String who = displayName(login);
        String expires = out.getShareExpiresAt() == null ? "never"
                : out.getShareExpiresAt().toLocalDate().toString();

        // The e-mail body lives in a notification-service template (app.notify.email-template), not in code,
        // so the wording can change without a redeploy.
        String note = req.note() == null || req.note().isBlank() ? ""
                : "<br><div>Note from sender: " + esc(req.note().trim()) + "</div>";
        Map<String, Object> params = new java.util.LinkedHashMap<>();
        params.put("toList", req.to().trim());
        params.put("reportName", title);
        params.put("reportCode", out.getReportCode());
        params.put("fmt", out.getFmt());
        params.put("expires", expires);
        params.put("link", url);
        params.put("noteBlock", note);
        params.put("senderName", who);

        String res;
        try {
            res = org.springframework.web.client.RestClient.create()
                    .post().uri(notifyBaseUrl + "/api/email-templates/send")
                    .contentType(MediaType.APPLICATION_JSON)
                    // requestBy goes into the notification service's log — use the traceable login;
                    // `who` is the display name for the e-mail body.
                    .body(Map.of("templateCode", emailTemplateCode, "params", params,
                                 "requestBy", login == null ? "system" : login))
                    .retrieve().body(String.class);
        } catch (Exception e) {
            // Make clear the mail leg failed, not the link — the link was issued and still works.
            throw new BadRequestException("Failed to send e-mail: " + e.getMessage()
                    + " (the link was created; you can copy and send it yourself)");
        }
        // The notification service answers 200 even when SMTP rejects (e.g. 452 Too many recipients)
        // — check failCount, otherwise the screen would report success for undelivered mail.
        if (res != null && res.contains("\"failCount\"") && !res.contains("\"failCount\":0")) {
            throw new BadRequestException("Notification service accepted the request but some messages failed: " + res);
        }

        // ---- In-app notification ----------------------------------------------------------------
        // Recipients are free-typed e-mails, so map them to system users here. External
        // recipients (not in the user directory) get no in-app notification, which is correct —
        // they have no screen to see it. Everyone still gets the e-mail.
        List<String> userIds = lookupUserIds(req.to());
        if (!userIds.isEmpty()) {
            try {
                org.springframework.web.client.RestClient.create()
                        .post().uri(notifyBaseUrl + "/api/notify/internal")
                        .contentType(MediaType.APPLICATION_JSON)
                        .body(Map.of("notiConfigCode", inAppConfigCode, "userIds", userIds,
                                     "createdBy", login == null ? "system" : login))
                        .retrieve().toBodilessEntity();
            } catch (Exception e) {
                // The e-mail already went out; a failed notification must not fail the request.
                log.warn("Failed to send in-app notification objectKey={} users={}", objectKey, userIds, e);
            }
        }
        return new EmailShareResult(req.to().trim(), url, out.getShareExpiresAt(), userIds.size());
    }

    /** Escape user-typed HTML before inserting it into the e-mail body. */
    private static String esc(String s) {
        return s == null ? "" : s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private ShareDto shareDto(OutputFile o) {
        return o.getShareToken() == null ? null
                : new ShareDto(o.getShareToken(), publicBaseUrl() + sharePath(o.getShareToken()),
                        sharePath(o.getShareToken()),
                        o.getShareExpiresAt(), o.getSharedBy(), o.getSharedAt(), o.getShareHits());
    }

    /** Stream a stored output back to the caller as a file download. */
    @GetMapping("/outputs/{objectKey}/download")
    public ResponseEntity<byte[]> download(@PathVariable String objectKey, Authentication auth) {
        OutputFile out = outputs.findByObjectKey(objectKey)
                .orElseThrow(() -> new NotFoundException("Output not found: " + objectKey));
        if (!canAccess(out, auth)) {
            // Deny as a 404, not a 403: a 403 would confirm the object exists and turn this
            // endpoint into an enumeration oracle for other users' analytics exports.
            throw new NotFoundException("Output not found: " + objectKey);
        }
        byte[] body = storage.get(out.getObjectKey());
        ContentDisposition cd = ContentDisposition.attachment().filename(downloadFilename(out),
                java.nio.charset.StandardCharsets.UTF_8).build();
        return ResponseEntity.ok()
                .contentType(contentTypeFor(out.getFmt()))
                .header(HttpHeaders.CONTENT_DISPOSITION, cd.toString())
                .body(body);
    }

    /**
     * Filename offered on download — the report's real name, not the object key.
     *
     * <p>Object keys are collision-proof ({@code CODE/CODE_unit_epoch.pdf}) but unreadable when many
     * downloads pile up, so the name is rebuilt as {@code <code> <report name>.<ext>} while the
     * stored object key stays unchanged.
     *
     * <p>Characters invalid in filenames are stripped and the length is capped. If the report name
     * is unknown (e.g. an ad-hoc file with no report code), the key's filename is used.
     */
    private String downloadFilename(OutputFile out) {
        String keyName = out.getObjectKey().substring(out.getObjectKey().lastIndexOf('/') + 1);
        String code = out.getReportCode();
        if (code == null || code.isBlank()) {
            return keyName;
        }
        String name = reports.findByCode(code).map(Report::getName).orElse(null);
        if (name == null || name.isBlank()) {
            return keyName;
        }
        int dot = keyName.lastIndexOf('.');
        String ext = dot > 0 ? keyName.substring(dot) : "";
        // \\ / : * ? " < > | are invalid in Windows filenames; newline/tab would corrupt the header.
        String clean = name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", " ")
                             .replaceAll("\\s+", " ").trim();
        if (clean.length() > 120) {
            clean = clean.substring(0, 120).trim();
        }
        return clean.isEmpty() ? keyName : code + " " + clean + ext;
    }

    /**
     * Whether {@code auth} may read {@code out}. Report-run outputs (a {@code jobId} is present)
     * are shared across the signed-in team; analytics / saved-view exports are visible only to
     * their creator. An {@code ADMIN} may read anything. Synthetic owners ({@code public} /
     * {@code anonymous}) are never matched to a real caller.
     */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.acl.AclService acl;

    /** Level-2: outputs of a report with an OUTPUT ACL are only for its grantees. */
    private boolean outputAllowed(String reportCode) {
        return acl == null || reportCode == null || acl.allowed("OUTPUT", reportCode, "view");
    }

    private <T> List<T> outputFilter(List<T> rows, java.util.function.Function<T, String> codeOf) {
        if (acl == null) return rows;
        return acl.filter("OUTPUT", rows, r -> String.valueOf(codeOf.apply(r)), "view");
    }

    private boolean canAccess(OutputFile out, Authentication auth) {
        if (isAdmin(auth)) {
            return true;
        }
        if (!outputAllowed(out.getReportCode())) {
            return false;
        }
        // Only the requester's own outputs (report runs carry the requester in createdBy); a run's data
        // may be row-filtered for that user, so it is never team-visible. Others use the share link.
        String owner = out.getCreatedBy();
        if (owner == null || PUBLIC.equals(owner) || ANONYMOUS.equals(owner)) {
            return false;
        }
        return auth != null && owner.equals(auth.getName());
    }

    private static boolean isAdmin(Authentication auth) {
        return auth != null && auth.getAuthorities().stream()
                .anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
    }

    private static MediaType contentTypeFor(String fmt) {
        if (fmt == null) return MediaType.APPLICATION_OCTET_STREAM;
        return switch (fmt.toUpperCase()) {
            case "PDF" -> MediaType.APPLICATION_PDF;
            case "XLSX" -> MediaType.parseMediaType(
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            case "CSV" -> MediaType.parseMediaType("text/csv");
            case "DOCX" -> MediaType.parseMediaType(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            default -> MediaType.APPLICATION_OCTET_STREAM;
        };
    }

    private OutputFileDto toDto(OutputFile o, String reportName, OutputReview review) {
        return toDto(o, reportName, null, review);
    }

    private OutputFileDto toDto(OutputFile o, String reportName, String categoryName, OutputReview review) {
        return new OutputFileDto(
                o.getObjectKey(),
                o.getReportCode(),
                reportName,
                categoryName,
                o.getJobId(),
                o.getFmt(),
                o.getSizeBytes(),
                o.getCreatedBy(),
                o.getCreatedAt(),
                o.getParams(),
                review == null ? null
                        : new ReviewDto(review.getConfirmedBy(), review.getConfirmedAt(), review.getNote()),
                shareDto(o),
                fileHubDto(o));
    }

    /** Listing shape for {@code GET /outputs}. */
    public record OutputFileDto(
            String objectKey,
            String reportCode,
            String reportName,
            /** Report category name — null when the report is no longer in the registry. */
            String categoryName,
            String jobId,
            String fmt,
            long sizeBytes,
            String createdBy,
            OffsetDateTime createdAt,
            String params,
            /** null = nobody has confirmed reviewing this file yet. */
            ReviewDto review,
            /** null = this file is not shared. */
            ShareDto share,
            /** null = not published to FileHub. */
            FileHubDto filehub
    ) {}

    /** One report in the Output Files folder sidebar. */
    public record OutputTreeRow(
            String reportCode,
            /** null = this code is no longer in the report registry. */
            String reportName,
            /** null = no category (not in the registry, or no category assigned). */
            String categoryName,
            long files,
            long sizeBytes,
            OffsetDateTime latestAt
    ) {}

    /** One page of output files plus the total for that filter. */
    public record OutputPage(List<OutputFileDto> items, long total) {}

    /** Who confirmed the review, when, and the reviewer's note. */
    public record ReviewDto(String confirmedBy, OffsetDateTime confirmedAt, String note) {}

    /** Request body of {@code POST /outputs/confirm}. */
    public record ConfirmRequest(String objectKey, String note) {}
}
