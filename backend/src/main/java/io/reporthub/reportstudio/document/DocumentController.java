package io.reporthub.reportstudio.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.reporthub.reportstudio.storage.ObjectStorageService;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Documents API: CRUD, data resolution for bound tables, image assets (MinIO) and PDF export.
 *
 * <p>Documents are tenant + project scoped. The print page that the exporter renders is not signed
 * in, so it reads the document through {@code /public/documents/{id}/print} with a short-lived
 * token signed by the backend ({@link DocumentPrintTokens}) that carries the document id, the
 * tenant/project and the principal of the user who requested the export. The page therefore sees
 * only that document, in that scope, with that user's object ACLs and row filters.
 */
@RestController
public class DocumentController {

    public record DocumentSummary(Long id, String title, String description, String folder, Integer revision,
                                  String createdBy, OffsetDateTime createdAt, String updatedBy, OffsetDateTime updatedAt,
                                  /** Last FileHub publication of the exported PDF (null = never). */
                                  String filehubFileId, String filehubUrl, OffsetDateTime filehubPublishedAt) {}
    public record FileHubPublishRequest(String connectorId, Map<String, Object> params) {}
    public record DocumentDto(Long id, String title, String description, String folder, Integer revision,
                              Object content, String updatedBy, OffsetDateTime updatedAt) {}
    public record SaveDocumentRequest(@NotBlank String title, String description, String folder,
                                      Object content, Integer revision) {}
    public record DataRequest(Map<String, Object> params) {}
    public record PrintPayload(DocumentDto document, Map<String, String> params,
                               Map<String, DocumentDataService.BlockData> data) {}
    public record AssetDto(Long id, String filename, String contentType, Long sizeBytes, String url) {}

    private final DocumentRepository repo;
    private final DocumentAssetRepository assets;
    private final DocumentDataService dataService;
    private final DocumentExporterClient exporter;
    private final ObjectStorageService storage;
    private final ObjectMapper json;
    private final DocumentPrintTokens tokens;
    private final io.reporthub.reportstudio.acl.AclService acl;

    public DocumentController(DocumentRepository repo, DocumentAssetRepository assets,
                              DocumentDataService dataService, DocumentExporterClient exporter,
                              ObjectStorageService storage, ObjectMapper json,
                              DocumentPrintTokens tokens, io.reporthub.reportstudio.acl.AclService acl) {
        this.repo = repo;
        this.assets = assets;
        this.dataService = dataService;
        this.exporter = exporter;
        this.storage = storage;
        this.json = json;
        this.tokens = tokens;
        this.acl = acl;
    }

    // --- CRUD ---------------------------------------------------------------

    @GetMapping("/documents")
    public List<DocumentSummary> list() {
        return acl.filter(ACL_TYPE, repo.findAllByOrderByUpdatedAtDesc(), d -> String.valueOf(d.getId()), "view")
                .stream().map(DocumentController::summary).toList();
    }

    public static final String ACL_TYPE = "DOCUMENT";

    @GetMapping("/documents/{id}")
    public DocumentDto get(@PathVariable Long id) {
        return dto(require(id));
    }

    @PostMapping("/documents")
    @ResponseStatus(HttpStatus.CREATED)
    public DocumentDto create(@Valid @RequestBody SaveDocumentRequest req, Authentication auth) {
        Document d = new Document();
        OffsetDateTime now = OffsetDateTime.now();
        d.setCreatedBy(user(auth));
        d.setCreatedAt(now);
        d.setRevision(1);
        apply(d, req, auth);
        return dto(repo.save(d));
    }

    @PutMapping("/documents/{id}")
    public DocumentDto update(@PathVariable Long id, @Valid @RequestBody SaveDocumentRequest req, Authentication auth) {
        Document d = require(id);
        if (req.revision() != null && !req.revision().equals(d.getRevision())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This document was saved by " + d.getUpdatedBy() + " in the meantime — reload to get the latest version");
        }
        d.setRevision(d.getRevision() + 1);
        apply(d, req, auth);
        return dto(repo.save(d));
    }

    @PostMapping("/documents/{id}/copy")
    @ResponseStatus(HttpStatus.CREATED)
    public DocumentDto copy(@PathVariable Long id, Authentication auth) {
        Document src = require(id);
        Document d = new Document();
        d.setTitle(src.getTitle() + " (copy)");
        d.setDescription(src.getDescription());
        d.setFolder(src.getFolder());
        d.setContent(src.getContent());
        d.setRevision(1);
        d.setCreatedBy(user(auth));
        d.setCreatedAt(OffsetDateTime.now());
        d.setUpdatedBy(user(auth));
        d.setUpdatedAt(OffsetDateTime.now());
        return dto(repo.save(d));
    }

    @DeleteMapping("/documents/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        Document d = require(id);
        for (DocumentAsset a : assets.findByDocumentIdOrderByCreatedAtDesc(id)) {
            try { storage.delete(a.getObjectKey()); } catch (Exception ignore) { /* best effort */ }
        }
        repo.delete(d);
    }

    // --- data + export ------------------------------------------------------

    @PostMapping("/documents/{id}/data")
    public Map<String, DocumentDataService.BlockData> data(@PathVariable Long id, @RequestBody(required = false) DataRequest req) {
        return dataService.resolve(require(id).getContent(), req == null ? Map.of() : nz(req.params()));
    }

    /** Resolve data for unsaved editor content (live preview while editing). */
    @PostMapping("/documents/data")
    public Map<String, DocumentDataService.BlockData> dataFor(@RequestBody Map<String, Object> body) {
        try {
            String content = json.writeValueAsString(body.get("content"));
            @SuppressWarnings("unchecked")
            Map<String, Object> params = body.get("params") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
            return dataService.resolve(content, params);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new BadRequestException("content is not serialisable");
        }
    }

    @PostMapping("/documents/{id}/pdf")
    public ResponseEntity<byte[]> pdf(@PathVariable Long id, @RequestBody(required = false) DataRequest req) {
        Document d = require(id);
        byte[] bytes = exporter.pdf(id, req == null ? Map.of() : nz(req.params()), tokens.mint(id));
        String name = d.getTitle().replaceAll("[^A-Za-z0-9._ -]", "_").trim();
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + (name.isEmpty() ? "document" : name) + ".pdf\"")
                .body(bytes);
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.integration.FileHubService fileHub;

    /** Export the document to PDF and publish it to FileHub; the FileHub id + link are kept on the document. */
    @PostMapping("/documents/{id}/filehub")
    public DocumentSummary publishToFileHub(@PathVariable Long id, @RequestBody(required = false) FileHubPublishRequest req) {
        if (fileHub == null) throw new BadRequestException("FileHub integration is not available");
        Document d = require(id);
        var c = fileHub.resolve(req == null ? null : req.connectorId());
        byte[] pdf = exporter.pdf(id, req == null || req.params() == null ? Map.of() : nz(req.params()), tokens.mint(id));
        String name = d.getTitle().replaceAll("[\\/:*?\"<>|]", "_").trim();
        try {
            var p = fileHub.upload(c, pdf, (name.isEmpty() ? "document" : name) + ".pdf", "application/pdf",
                    io.reporthub.reportstudio.integration.DeliveryPath.render(c.str("folderPath"), "documents", java.time.LocalDate.now()),
                    "documents");
            d.setFilehubConnectorId(p.connectorId());
            d.setFilehubFileId(p.fileId());
            d.setFilehubUrl(p.url());
            d.setFilehubPublishedAt(p.publishedAt());
            repo.save(d);
        } catch (io.reporthub.reportstudio.integration.FileHubClient.FileHubException e) {
            throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.BAD_GATEWAY, e.getMessage());
        }
        return summary(d);
    }

    @GetMapping("/public/documents/{id}/print")
    public PrintPayload print(@PathVariable Long id, @RequestParam(value = "token", required = false) String token,
                              @RequestParam Map<String, String> query) {
        DocumentPrintTokens.Claims c;
        try {
            c = tokens.verify(token, id);
        } catch (SecurityException e) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, e.getMessage());
        }
        // Load + resolve inside the token's tenant/project, as the user who asked for the export.
        return io.reporthub.reportstudio.tenancy.TenantContext.callAs(c.scope(), () -> {
            java.util.concurrent.atomic.AtomicReference<PrintPayload> out = new java.util.concurrent.atomic.AtomicReference<>();
            Runnable work = () -> out.set(printPayload(id, query));
            if (c.u() == null) work.run();
            else io.reporthub.reportstudio.iam.CurrentPrincipal.runAs(c.u(), work);
            return out.get();
        });
    }

    private PrintPayload printPayload(Long id, Map<String, String> query) {
        Document d;
        try {
            d = require(id);
        } catch (io.reporthub.reportstudio.tenancy.OutOfScopeException e) {
            throw new NotFoundException("Document " + id + " not found");
        }
        acl.require(ACL_TYPE, String.valueOf(id), "run");
        Map<String, Object> params = new java.util.LinkedHashMap<>();
        query.forEach((k, v) -> { if (k.startsWith("p.")) params.put(k.substring(2), v); });
        try {
            Map<String, String> eff = dataService.effectiveParams(json.readTree(d.getContent()), params);
            return new PrintPayload(dto(d), eff, dataService.resolve(d.getContent(), params, false));
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new BadRequestException("Document content is not valid JSON");
        }
    }

    // --- assets -------------------------------------------------------------

    @PostMapping(value = "/documents/{id}/assets", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @ResponseStatus(HttpStatus.CREATED)
    public AssetDto upload(@PathVariable Long id, @RequestParam("file") MultipartFile file, Authentication auth) throws Exception {
        require(id);
        String ct = file.getContentType() == null ? "application/octet-stream" : file.getContentType();
        if (!ct.startsWith("image/")) throw new BadRequestException("Only image files can be added to a document");
        String filename = file.getOriginalFilename() == null ? "image" : file.getOriginalFilename().replaceAll("[^A-Za-z0-9._-]", "_");
        String token = UUID.randomUUID().toString().replace("-", "");
        String key = "documents/assets/" + token + "/" + filename;
        storage.put(key, file.getBytes(), ct);
        DocumentAsset a = new DocumentAsset();
        a.setDocumentId(id);
        a.setObjectKey(key);
        a.setFilename(filename);
        a.setContentType(ct);
        a.setSizeBytes(file.getSize());
        a.setCreatedBy(user(auth));
        a.setCreatedAt(OffsetDateTime.now());
        assets.save(a);
        return assetDto(a, token);
    }

    @GetMapping("/documents/{id}/assets")
    public List<AssetDto> listAssets(@PathVariable Long id) {
        return assets.findByDocumentIdOrderByCreatedAtDesc(id).stream()
                .map(a -> assetDto(a, a.getObjectKey().split("/")[2])).toList();
    }

    /** Asset bytes by their unguessable token — public so that {@code <img>} tags and the print page can load them. */
    @GetMapping("/public/documents/assets/{token}")
    public ResponseEntity<byte[]> asset(@PathVariable String token) {
        if (!token.matches("[0-9a-f]{32}")) throw new NotFoundException("Asset not found");
        DocumentAsset a = assets.findFirstByObjectKeyStartingWith("documents/assets/" + token + "/")
                .orElseThrow(() -> new NotFoundException("Asset not found"));
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(a.getContentType() == null ? "application/octet-stream" : a.getContentType()))
                .header(HttpHeaders.CACHE_CONTROL, "public, max-age=31536000, immutable")
                .body(storage.get(a.getObjectKey()));
    }

    // --- helpers ------------------------------------------------------------

    static final String DEFAULT_CONTENT = "{\"version\":1,\"page\":{\"size\":\"a4\",\"orientation\":\"portrait\","
            + "\"marginsMm\":{\"top\":20,\"right\":18,\"bottom\":20,\"left\":18}},\"params\":[],\"sections\":[]}";

    static final java.util.Map<String, double[]> PAGE_SIZES_MM = java.util.Map.of(
            "a4", new double[]{210, 297}, "a5", new double[]{148, 210}, "b5", new double[]{182, 257},
            "letter", new double[]{215.9, 279.4}, "legal", new double[]{215.9, 355.6});

    /** Structural checks on document content: page settings, sections and params. 400 on any problem. */
    static void validateContent(com.fasterxml.jackson.databind.JsonNode c) {
        if (c == null || !c.isObject()) throw new BadRequestException("content must be a JSON object");
        com.fasterxml.jackson.databind.JsonNode page = c.path("page");
        if (!page.isObject()) throw new BadRequestException("content.page is required");
        com.fasterxml.jackson.databind.JsonNode size = page.path("size");
        double w, h;
        if (size.isTextual()) {
            double[] d = PAGE_SIZES_MM.get(size.asText().toLowerCase(java.util.Locale.ROOT));
            if (d == null) throw new BadRequestException("content.page.size: unknown page size '" + size.asText()
                    + "' (allowed: " + String.join(", ", new java.util.TreeSet<>(PAGE_SIZES_MM.keySet())) + " or {widthMm, heightMm})");
            w = d[0]; h = d[1];
        } else if (size.isObject()) {
            w = size.path("widthMm").asDouble(0);
            h = size.path("heightMm").asDouble(0);
            if (w < 50 || h < 50 || w > 2000 || h > 2000) {
                throw new BadRequestException("content.page.size: widthMm/heightMm must be between 50 and 2000");
            }
        } else {
            throw new BadRequestException("content.page.size is required");
        }
        String o = page.path("orientation").asText("");
        if (!o.equals("portrait") && !o.equals("landscape")) {
            throw new BadRequestException("content.page.orientation must be portrait or landscape");
        }
        if (o.equals("landscape")) { double t = w; w = h; h = t; }
        com.fasterxml.jackson.databind.JsonNode m = page.path("marginsMm");
        if (!m.isObject()) throw new BadRequestException("content.page.marginsMm is required");
        double[] mm = new double[4];
        String[] sides = {"top", "right", "bottom", "left"};
        for (int i = 0; i < 4; i++) {
            com.fasterxml.jackson.databind.JsonNode v = m.path(sides[i]);
            if (!v.isNumber() || v.asDouble() < 0) {
                throw new BadRequestException("content.page.marginsMm." + sides[i] + " must be a number >= 0");
            }
            mm[i] = v.asDouble();
        }
        if (mm[1] + mm[3] >= w - 10 || mm[0] + mm[2] >= h - 10) {
            throw new BadRequestException("content.page.marginsMm leave no room for content on this page size");
        }
        if (page.has("fontSizePt") && (!page.path("fontSizePt").isNumber()
                || page.path("fontSizePt").asDouble() < 4 || page.path("fontSizePt").asDouble() > 72)) {
            throw new BadRequestException("content.page.fontSizePt must be between 4 and 72");
        }
        if (!c.path("sections").isArray()) throw new BadRequestException("content.sections must be an array");
        if (c.has("params") && !c.path("params").isArray()) throw new BadRequestException("content.params must be an array");
        for (com.fasterxml.jackson.databind.JsonNode p : c.path("params")) {
            if (!p.path("name").asText("").matches("[A-Za-z0-9_.]+")) {
                throw new BadRequestException("content.params: each parameter needs a name of letters, digits, '_' or '.'");
            }
        }
    }

    private void apply(Document d, SaveDocumentRequest req, Authentication auth) {
        d.setTitle(req.title().trim());
        d.setDescription(req.description());
        d.setFolder(req.folder());
        try {
            if (req.content() == null) {
                d.setContent(DEFAULT_CONTENT);
            } else {
                validateContent(json.valueToTree(req.content()));
                d.setContent(json.writeValueAsString(req.content()));
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new BadRequestException("content is not serialisable");
        }
        d.setUpdatedBy(user(auth));
        d.setUpdatedAt(OffsetDateTime.now());
    }

    private Document require(Long id) {
        return repo.findById(id).orElseThrow(() -> new NotFoundException("Document " + id + " not found"));
    }

    private DocumentDto dto(Document d) {
        Object content;
        try {
            content = json.readTree(d.getContent());
        } catch (Exception e) {
            content = null;
        }
        return new DocumentDto(d.getId(), d.getTitle(), d.getDescription(), d.getFolder(), d.getRevision(),
                content, d.getUpdatedBy(), d.getUpdatedAt());
    }

    private static DocumentSummary summary(Document d) {
        return new DocumentSummary(d.getId(), d.getTitle(), d.getDescription(), d.getFolder(), d.getRevision(),
                d.getCreatedBy(), d.getCreatedAt(), d.getUpdatedBy(), d.getUpdatedAt(),
                d.getFilehubFileId(), d.getFilehubUrl(), d.getFilehubPublishedAt());
    }

    private static AssetDto assetDto(DocumentAsset a, String token) {
        return new AssetDto(a.getId(), a.getFilename(), a.getContentType(), a.getSizeBytes(),
                "/public/documents/assets/" + token);
    }

    private static Map<String, Object> nz(Map<String, Object> m) {
        return m == null ? Map.of() : m;
    }

    private static String user(Authentication auth) {
        return auth == null ? "system" : auth.getName();
    }
}
