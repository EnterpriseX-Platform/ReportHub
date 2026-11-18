package io.reporthub.reportstudio.web;

import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.analytics.AdhocRequest;
import io.reporthub.reportstudio.analytics.AdhocResult;
import io.reporthub.reportstudio.analytics.AdhocService;
import io.reporthub.reportstudio.analytics.DatasetDto;
import io.reporthub.reportstudio.analytics.PivotRequest;
import io.reporthub.reportstudio.analytics.PivotResponse;
import io.reporthub.reportstudio.analytics.PivotService;
import io.reporthub.reportstudio.analytics.XlsxExporter;
import io.reporthub.reportstudio.domain.AdhocRunLog;
import io.reporthub.reportstudio.domain.OutputFile;
import io.reporthub.reportstudio.domain.SavedView;
import io.reporthub.reportstudio.repo.AdhocRunLogRepository;
import io.reporthub.reportstudio.repo.FactRepository;
import io.reporthub.reportstudio.repo.OutputFileRepository;
import io.reporthub.reportstudio.repo.SavedViewRepository;
import io.reporthub.reportstudio.storage.ObjectStorageService;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/**
 * Analytics Workbench (pivot) + Ad-hoc query endpoints.
 * Both pivot and ad-hoc compute server-side over the fact warehouse table,
 * and export to real .xlsx via Apache POI.
 */
@RestController
public class AnalyticsController {

    private static final MediaType XLSX =
            MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    /** createdBy marker for the unauthenticated public-view surface; these pulls are not persisted. */
    private static final String PUBLIC = "public";

    private final PivotService pivotService;
    private final AdhocService adhocService;
    private final XlsxExporter xlsx;
    private final FactRepository facts;
    private final AdhocRunLogRepository runLog;
    private final SavedViewRepository views;
    private final io.reporthub.reportstudio.service.ViewExportService viewExport;
    private final ObjectStorageService storage;
    private final OutputFileRepository outputFiles;

    public AnalyticsController(PivotService pivotService,
                               AdhocService adhocService,
                               XlsxExporter xlsx,
                               FactRepository facts,
                               AdhocRunLogRepository runLog,
                               SavedViewRepository views,
                               io.reporthub.reportstudio.service.ViewExportService viewExport,
                               ObjectStorageService storage,
                               OutputFileRepository outputFiles) {
        this.pivotService = pivotService;
        this.adhocService = adhocService;
        this.xlsx = xlsx;
        this.facts = facts;
        this.runLog = runLog;
        this.views = views;
        this.viewExport = viewExport;
        this.storage = storage;
        this.outputFiles = outputFiles;
    }

    /**
     * Persist a generated analytics artifact into THIS system's object storage and record an
     * OutputFile row BEFORE it is streamed to the caller. Enforces the invariant that every generated
     * file is captured here regardless of which surface produced it. A storage failure propagates and
     * fails the export rather than handing out an un-captured file.
     */
    private void persistExport(byte[] body, String fmt, String sourceCode, String contentType, String createdBy) {
        if (PUBLIC.equals(createdBy)) {
            // Unauthenticated /public/view pulls are reproducible from the warehouse on demand, so we do
            // NOT capture them into the shared output store — that would expose anonymously-pulled data to
            // every authenticated user and let a crawler amplify storage. They stay ephemeral by design.
            return;
        }
        // Key by content hash so byte-identical exports reuse ONE stored object + row. This dedups
        // deterministic formats (CSV/JSON); XLSX embeds a timestamp so its bytes differ per export and it
        // still gets a fresh object — acceptable, since the unbounded vector (the unauthenticated public
        // path) is skipped above and authenticated one-object-per-export mirrors the report-run path.
        String objectKey = "analytics/" + sourceCode + "_" + sha256Hex(body).substring(0, 16)
                + "." + fmt.toLowerCase();
        if (outputFiles.findByObjectKey(objectKey).isPresent()) {
            return; // identical content already captured
        }
        var meta = storage.put(objectKey, body, contentType);
        OutputFile out = new OutputFile();
        out.setObjectKey(meta.objectKey());
        out.setReportCode(sourceCode);
        out.setFmt(fmt.toUpperCase());
        out.setSizeBytes(meta.sizeBytes());
        out.setCreatedBy(createdBy);
        out.setCreatedAt(OffsetDateTime.now());
        try {
            outputFiles.save(out);
        } catch (org.springframework.dao.DataIntegrityViolationException dup) {
            // A concurrent identical export inserted this key first — the object is captured; done.
        } catch (RuntimeException e) {
            storage.delete(meta.objectKey()); // compensate: never leave an orphaned MinIO object
            throw e;
        }
    }

    private static String sha256Hex(byte[] data) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(data);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static String createdBy(Authentication auth) {
        return auth == null ? "anonymous" : auth.getName();
    }

    /** Warehouse metadata: real row count + distinct dimension values (for filters). */
    @GetMapping("/analytics/meta")
    public Map<String, Object> meta() {
        return Map.of(
                "factCount", facts.count(),
                "fiscalYears", facts.distinctFiscalYears(),
                "regions", facts.distinctRegions(),
                "categories", facts.distinctCategories(),
                "channels", facts.distinctChannels());
    }

    // ---- Analytics Workbench (pivot) ----

    @PostMapping("/analytics/pivot")
    public PivotResponse pivot(@RequestBody PivotRequest req) {
        return pivotService.pivot(req);
    }

    @PostMapping("/analytics/export")
    public ResponseEntity<byte[]> exportPivot(@RequestBody PivotRequest req, Authentication auth) {
        byte[] body = xlsx.pivot(pivotService.pivot(req));
        persistExport(body, "xlsx", "analytics-pivot", XLSX.toString(), createdBy(auth));
        return xlsxResponse(body, "pivot.xlsx");
    }

    // ---- Ad-hoc query ----

    @GetMapping("/adhoc/datasets")
    public List<DatasetDto> datasets() {
        return adhocService.datasets();
    }

    @PostMapping("/adhoc/run")
    public AdhocResult run(@RequestBody AdhocRequest req, Authentication auth) {
        AdhocResult result = adhocService.run(req);
        // Real history: append one row per executed query.
        try {
            AdhocRunLog log = new AdhocRunLog();
            log.setDataset(req.dataset() == null ? "fact" : req.dataset());
            log.setFields(String.join(",", req.fields()));
            log.setFilters(req.filters() == null ? null : req.filters().toString());
            log.setRowCount(result.rowCount());
            log.setCreatedBy(auth == null ? "anonymous" : auth.getName());
            log.setCreatedAt(OffsetDateTime.now());
            runLog.save(log);
        } catch (Exception ignored) {
            // history is best-effort; never fail the query for it
        }
        return result;
    }

    /** Real recent-queries panel (latest 10 executed ad-hoc queries). */
    @GetMapping("/adhoc/history")
    public List<Map<String, Object>> history() {
        return runLog.findTop10ByOrderByCreatedAtDesc().stream()
                .<Map<String, Object>>map(l -> Map.of(
                        "id", l.getId(),
                        "dataset", l.getDataset(),
                        "fields", l.getFields(),
                        "filters", l.getFilters() == null ? "" : l.getFilters(),
                        "rowCount", l.getRowCount(),
                        "createdBy", l.getCreatedBy() == null ? "" : l.getCreatedBy(),
                        "createdAt", l.getCreatedAt()))
                .toList();
    }

    // ---- saved views (pivot + ad-hoc) ----

    public record SaveViewRequest(String kind, String name, String dataset, String payload,
                                  Long workspaceId, String folder, Boolean isPublic) {}
    public record MoveViewRequest(String folder) {}
    public record VisibilityRequest(Boolean isPublic) {}

    /**
     * Sidebar list for the caller = their own items plus items others have made public.
     *
     * Every item used to be returned to everyone (never filtered by owner), so one user's
     * experimental scripts appeared on everyone's screen. ADMIN still sees all, to manage leftovers.
     */
    @GetMapping("/views")
    public List<SavedView> listViews(@RequestParam String kind,
                                     @RequestParam(required = false) Long workspace,
                                     Authentication auth) {
        String me = auth == null ? null : auth.getName();
        boolean admin = auth != null && auth.getAuthorities().stream()
                .anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
        return views.findByKindOrderByCreatedAtDesc(kind).stream()
                .filter(v -> workspace == null || workspace.equals(v.getWorkspaceId()))
                .filter(v -> admin || Boolean.TRUE.equals(v.getIsPublic())
                        || (me != null && me.equals(v.getCreatedBy())))
                .toList();
    }

    /** Move a script into/out of a folder — blank or null = back to the top level. */
    @PostMapping("/views/{id}/move")
    public SavedView moveView(@PathVariable Long id, @RequestBody MoveViewRequest req, Authentication auth) {
        SavedView v = ownedView(id, auth);
        v.setFolder(req.folder() == null || req.folder().isBlank() ? null : req.folder().trim());
        return views.save(v);
    }

    /** Toggle private <-> public. */
    @PostMapping("/views/{id}/visibility")
    public SavedView setViewVisibility(@PathVariable Long id, @RequestBody VisibilityRequest req, Authentication auth) {
        SavedView v = ownedView(id, auth);
        v.setIsPublic(Boolean.TRUE.equals(req.isPublic()));
        return views.save(v);
    }

    /**
     * Whether the caller owns this item — users cannot edit/delete others' items even when visible
     * because public. ADMIN passes, as do legacy rows with blank/anonymous createdBy (no owner to protect).
     */
    private SavedView ownedView(Long id, Authentication auth) {
        SavedView v = views.findById(id).orElseThrow(() -> new BadRequestException("View not found"));
        String me = auth == null ? null : auth.getName();
        boolean admin = auth != null && auth.getAuthorities().stream()
                .anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
        String owner = v.getCreatedBy();
        boolean ownerless = owner == null || owner.isBlank() || "anonymous".equals(owner);
        if (admin || ownerless || (me != null && me.equals(owner))) return v;
        throw new BadRequestException("This script belongs to " + owner + " — only the owner can change it");
    }

    @PostMapping("/views")
    @ResponseStatus(HttpStatus.CREATED)
    public SavedView saveView(@RequestBody SaveViewRequest req, Authentication auth) {
        // "sql" = a script saved from the Tables screen's SQL Editor. The screen always sent this value
        // and api.ts declares "pivot" | "adhoc" | "sql", but this guard never accepted it, so saving
        // always failed and the "Saved SQL scripts" panel (kind=sql) stayed empty.
        if (req.kind() == null || !List.of("pivot", "adhoc", "sql").contains(req.kind())) {
            throw new BadRequestException("kind must be pivot, adhoc or sql");
        }
        if (req.name() == null || req.name().isBlank()) {
            throw new BadRequestException("name is required");
        }
        SavedView v = new SavedView();
        v.setKind(req.kind());
        v.setName(req.name().trim());
        v.setDataset(req.dataset());
        v.setPayload(req.payload() == null ? "{}" : req.payload());
        // The screen sends 0 (not null) when the user has never picked a workspace
        // (getSharedWorkspace() reads empty localStorage and returns 0); 0 then hit
        // saved_view_workspace_id_fkey as a 500 and "Save" silently failed.
        // Any value that is not a real workspace id falls back to the default workspace 1.
        v.setWorkspaceId(req.workspaceId() == null || req.workspaceId() <= 0 ? 1L : req.workspaceId());
        v.setFolder(req.folder() == null || req.folder().isBlank() ? null : req.folder().trim());
        v.setIsPublic(Boolean.TRUE.equals(req.isPublic()));
        v.setCreatedBy(auth == null ? "anonymous" : auth.getName());
        v.setCreatedAt(OffsetDateTime.now());
        return views.save(v);
    }

    /**
     * Update a saved view (support for <b>updating</b> saved filter conditions).
     *
     * <p>Previously only POST /views existed, which always inserts — reopening a view, editing it and
     * saving under the same name created a duplicate row every time, so the sidebar showed repeated
     * names with no way to tell which was newest.
     *
     * <p>Uses the same owner guard as move/delete — others cannot edit an item even if it is public.
     * Null fields leave the existing value untouched (except folder, where blank means "remove from folder").
     */
    @PutMapping("/views/{id}")
    public SavedView updateView(@PathVariable Long id, @RequestBody SaveViewRequest req, Authentication auth) {
        SavedView v = ownedView(id, auth);
        if (req.name() != null && !req.name().isBlank()) v.setName(req.name().trim());
        if (req.dataset() != null) v.setDataset(req.dataset());
        if (req.payload() != null) v.setPayload(req.payload());
        if (req.folder() != null) v.setFolder(req.folder().isBlank() ? null : req.folder().trim());
        if (req.isPublic() != null) v.setIsPublic(req.isPublic());
        if (req.workspaceId() != null && req.workspaceId() > 0) v.setWorkspaceId(req.workspaceId());
        return views.save(v);
    }

    @DeleteMapping("/views/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteView(@PathVariable Long id, Authentication auth) {
        // Others can see public items but not delete them — same guard as moving folders.
        ownedView(id, auth);
        views.deleteById(id);
    }

    // ---- saved view as a DATA PRODUCT: share token + CSV/XLSX/JSON export ----

    @PostMapping("/views/{id}/share")
    public SavedView shareView(@PathVariable Long id) {
        SavedView v = views.findById(id).orElseThrow(() -> new BadRequestException("View not found"));
        if (v.getShareToken() == null) {
            v.setShareToken(java.util.UUID.randomUUID().toString().replace("-", ""));
            views.save(v);
        }
        return v;
    }

    @DeleteMapping("/views/{id}/share")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void unshareView(@PathVariable Long id) {
        views.findById(id).ifPresent(v -> { v.setShareToken(null); views.save(v); });
    }

    /** Execute the view and return its data — format=json|csv|xlsx (documented in OpenAPI). */
    @GetMapping("/views/{id}/export")
    public ResponseEntity<byte[]> exportView(@PathVariable Long id,
                                             @RequestParam(defaultValue = "json") String format,
                                             Authentication auth) {
        SavedView v = views.findById(id).orElseThrow(() -> new BadRequestException("View not found"));
        return renderView(v, format, createdBy(auth));
    }

    /** PUBLIC data-product URL (share token) — anyone/any tool can pull CSV/XLSX/JSON. */
    @GetMapping("/public/view/{token}")
    public ResponseEntity<byte[]> publicView(@PathVariable String token,
                                             @RequestParam(defaultValue = "json") String format) {
        SavedView v = views.findByShareToken(token)
                .orElseThrow(() -> new BadRequestException("View not found"));
        return renderView(v, format, PUBLIC);
    }

    private ResponseEntity<byte[]> renderView(SavedView v, String format, String createdBy) {
        io.reporthub.reportstudio.service.ViewExportService.Table t = viewExport.run(v);
        String safe = v.getName().replaceAll("[^\\p{L}\\p{N}_-]", "_");
        String sourceCode = "view-" + v.getId();
        switch (format.toLowerCase()) {
            case "csv" -> {
                byte[] body = viewExport.toCsv(t);
                persistExport(body, "csv", sourceCode, "text/csv; charset=UTF-8", createdBy);
                ContentDisposition cd = ContentDisposition.attachment().filename(safe + ".csv").build();
                return ResponseEntity.ok()
                        .contentType(MediaType.parseMediaType("text/csv; charset=UTF-8"))
                        .header(HttpHeaders.CONTENT_DISPOSITION, cd.toString())
                        .body(body);
            }
            case "xlsx" -> {
                byte[] body = viewExport.toXlsx(t);
                persistExport(body, "xlsx", sourceCode, XLSX.toString(), createdBy);
                return xlsxResponse(body, safe + ".xlsx");
            }
            default -> {
                byte[] body;
                try {
                    var rows = new java.util.ArrayList<java.util.Map<String, Object>>();
                    for (var r : t.rows()) {
                        var m = new java.util.LinkedHashMap<String, Object>();
                        for (int i = 0; i < t.columns().size(); i++) m.put(t.columns().get(i), r.get(i));
                        rows.add(m);
                    }
                    body = new com.fasterxml.jackson.databind.ObjectMapper()
                            .writerWithDefaultPrettyPrinter()
                            .writeValueAsBytes(java.util.Map.of(
                                    "view", v.getName(), "columns", t.columns(),
                                    "rowCount", t.rows().size(), "rows", rows));
                } catch (Exception e) {
                    throw new BadRequestException("JSON render failed");
                }
                persistExport(body, "json", sourceCode, "application/json", createdBy);
                return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(body);
            }
        }
    }

    @PostMapping("/adhoc/export")
    public ResponseEntity<byte[]> exportAdhoc(@RequestBody AdhocRequest req, Authentication auth) {
        byte[] body = xlsx.adhoc(adhocService.run(req));
        persistExport(body, "xlsx", "analytics-adhoc", XLSX.toString(), createdBy(auth));
        return xlsxResponse(body, "adhoc.xlsx");
    }

    private static ResponseEntity<byte[]> xlsxResponse(byte[] body, String filename) {
        ContentDisposition cd = ContentDisposition.attachment().filename(filename).build();
        return ResponseEntity.ok()
                .contentType(XLSX)
                .header(HttpHeaders.CONTENT_DISPOSITION, cd.toString())
                .body(body);
    }
}
