package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
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
import io.reporthub.reportstudio.domain.RepoFolder;
import io.reporthub.reportstudio.domain.RepoTable;
import io.reporthub.reportstudio.repo.RepoFolderRepository;
import io.reporthub.reportstudio.repo.RepoTableRepository;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * Folders for the Tables screen's navigation sidebar.
 *
 * Readable by any signed-in user (the screen needs them to render); create/update/delete is ADMIN — the rule
 * lives in SecurityConfig alongside /repository/registry, not on the methods.
 */
@RestController
@RequestMapping("/repository/folders")
public class RepoFolderController {

    private final RepoFolderRepository folders;
    private final RepoTableRepository tables;

    public RepoFolderController(RepoFolderRepository folders, RepoTableRepository tables) {
        this.folders = folders;
        this.tables = tables;
    }

    @GetMapping
    public List<RepoFolder> list(@RequestParam(required = false) String menu) {
        return menu == null || menu.isBlank()
                ? folders.findAllByOrderBySortOrderAscIdAsc()
                : folders.findByMenuKeyOrderBySortOrderAscIdAsc(menu);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public RepoFolder add(@Valid @RequestBody Upsert req) {
        RepoFolder f = new RepoFolder();
        f.setMenuKey(blankToNull(req.menuKey()));
        f.setParentId(req.parentId());
        f.setName(req.name().trim());
        // New folders always go to the end of their level, never in the middle
        f.setSortOrder(req.sortOrder() != null ? req.sortOrder() : nextOrder(req.menuKey(), req.parentId()));
        folders.save(f);
        return f;
    }

    @PutMapping("/{id}")
    public RepoFolder update(@PathVariable Integer id, @Valid @RequestBody Upsert req) {
        RepoFolder f = folders.findById(id)
                .orElseThrow(() -> new NotFoundException("No such folder: " + id));
        if (isDescendant(req.parentId(), id)) {
            throw new IllegalArgumentException("A folder cannot be moved inside itself");
        }
        f.setMenuKey(blankToNull(req.menuKey()));
        f.setParentId(req.parentId());
        f.setName(req.name().trim());
        if (req.sortOrder() != null) f.setSortOrder(req.sortOrder());
        f.setUpdatedAt(OffsetDateTime.now());
        folders.save(f);
        return f;
    }

    /**
     * Reorders a whole level at once — the page sends the full desired id order and sort_order is written
     * from each id's array position, avoiding one call per folder and half-applied intermediate states.
     */
    @PutMapping("/reorder")
    @Transactional
    public List<RepoFolder> reorder(@RequestBody Reorder req) {
        List<RepoFolder> out = folders.findAllById(req.ids());
        for (int i = 0; i < req.ids().size(); i++) {
            Integer id = req.ids().get(i);
            for (RepoFolder f : out) {
                if (f.getId().equals(id)) {
                    f.setSortOrder(i);
                    f.setUpdatedAt(OffsetDateTime.now());
                }
            }
        }
        folders.saveAll(out);
        return out;
    }

    /**
     * Deletes a folder — its contents (child folders and tables) are not deleted but move up to the parent.
     * Tables at the top level end up with no folder.
     */
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void remove(@PathVariable Integer id) {
        RepoFolder f = folders.findById(id).orElse(null);
        if (f == null) return;
        Integer parent = f.getParentId();

        for (RepoFolder child : folders.findByParentId(id)) {
            child.setParentId(parent);
            child.setUpdatedAt(OffsetDateTime.now());
            folders.save(child);
        }
        for (RepoTable t : tables.findByFolderId(id)) {
            t.setFolderId(parent);
            t.setUpdatedAt(OffsetDateTime.now());
            tables.save(t);
        }
        folders.delete(f);
    }

    private int nextOrder(String menuKey, Integer parentId) {
        return folders.findAllByOrderBySortOrderAscIdAsc().stream()
                .filter(x -> java.util.Objects.equals(blankToNull(x.getMenuKey()), blankToNull(menuKey)))
                .filter(x -> java.util.Objects.equals(x.getParentId(), parentId))
                .mapToInt(x -> x.getSortOrder() == null ? 0 : x.getSortOrder() + 1)
                .max().orElse(0);
    }

    /** Prevents dropping a folder into its own descendant, which would detach the branch from the root. */
    private boolean isDescendant(Integer candidateParent, Integer selfId) {
        Integer cur = candidateParent;
        int guard = 0;
        while (cur != null && guard++ < 64) {
            if (cur.equals(selfId)) return true;
            RepoFolder p = folders.findById(cur).orElse(null);
            cur = p == null ? null : p.getParentId();
        }
        return false;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    public record Upsert(String menuKey, Integer parentId, @NotBlank String name, Integer sortOrder) {
    }

    public record Reorder(List<Integer> ids) {
    }
}
