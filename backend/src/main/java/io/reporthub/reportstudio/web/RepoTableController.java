package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.domain.RepoTable;
import io.reporthub.reportstudio.repo.RepoTableRepository;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * The list of tables a data screen offers. Reading is open to any signed-in user because the
 * screen needs it to draw itself; adding and removing entries is ADMIN, so a portal user (who
 * only ever gets ROLE_USER through the edge filter) can use the screens but not re-point them.
 * The ADMIN rule lives in SecurityConfig with the other write rules, not on the methods.
 */
@RestController
@RequestMapping("/repository/registry")
public class RepoTableController {

    private final RepoTableRepository repo;

    public RepoTableController(RepoTableRepository repo) {
        this.repo = repo;
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.acl.AclService acl;

    @GetMapping
    public List<RepoTable> list(@RequestParam(required = false) String menu) {
        List<RepoTable> all = menu == null || menu.isBlank()
                ? repo.findByActiveTrueOrderBySortOrderAscIdAsc()
                : repo.findByMenuKeyAndActiveTrueOrderBySortOrderAscIdAsc(menu);
        return acl == null ? all : acl.filter("REPO_TABLE", all, t -> String.valueOf(t.getId()), "view");
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public RepoTable add(@Valid @RequestBody Upsert req) {
        RepoTable t = new RepoTable();
        apply(t, req);
        return repo.save(t);
    }

    @PutMapping("/{id}")
    public RepoTable update(@PathVariable Integer id, @Valid @RequestBody Upsert req) {
        RepoTable t = repo.findById(id)
                .orElseThrow(() -> new NotFoundException("Not on any screen: " + id));
        apply(t, req);
        return repo.save(t);
    }

    /** Soft delete — the entry leaves the screen but the history of what was shown survives. */
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void remove(@PathVariable Integer id) {
        repo.findById(id).ifPresent(t -> {
            t.setActive(false);
            t.setUpdatedAt(OffsetDateTime.now());
            repo.save(t);
        });
    }

    private static void apply(RepoTable t, Upsert req) {
        t.setMenuKey(blankToNull(req.menuKey()));
        t.setLabel(req.label().trim());
        t.setFolder(blankToNull(req.folder()));
        t.setFolderId(req.folderId());
        t.setDatasourceId(req.datasourceId().trim());
        t.setSchemaName(blankToNull(req.schemaName()));
        t.setTableName(req.tableName().trim());
        t.setEqFilter(blankToNull(req.eqFilter()));
        t.setFilterColumns(blankToNull(req.filterColumns()));
        t.setColumnOrder(blankToNull(req.columnOrder()));
        t.setHiddenColumns(blankToNull(req.hiddenColumns()));
        t.setColumnLabels(blankToNull(req.columnLabels()));
        t.setKeyColumns(blankToNull(req.keyColumns()));
        t.setYearColumn(blankToNull(req.yearColumn()));
        t.setSortOrder(req.sortOrder() == null ? 0 : req.sortOrder());
        t.setUpdatedAt(OffsetDateTime.now());
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    public record Upsert(
            String menuKey,
            @NotBlank String label,
            String folder,
            Integer folderId,
            @NotBlank String datasourceId,
            String schemaName,
            @NotBlank String tableName,
            String eqFilter,
            String filterColumns,
            String columnOrder,
            String hiddenColumns,
            String columnLabels,
            String keyColumns,
            Integer sortOrder,
            String yearColumn) {
    }
}
