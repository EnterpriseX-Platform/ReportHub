package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.domain.Workspace;
import io.reporthub.reportstudio.repo.WorkspaceRepository;

import java.time.OffsetDateTime;
import java.util.List;

/** Workspaces group saved views and dashboards (Power-BI-style). */
@RestController
public class WorkspaceController {

    public record SaveWorkspaceRequest(@NotBlank String name) {}

    private final WorkspaceRepository repo;

    public WorkspaceController(WorkspaceRepository repo) {
        this.repo = repo;
    }

    @GetMapping("/workspaces")
    public List<Workspace> list() {
        return repo.findAll();
    }

    @PostMapping("/workspaces")
    @ResponseStatus(HttpStatus.CREATED)
    public Workspace create(@Valid @RequestBody SaveWorkspaceRequest req, Authentication auth) {
        Workspace w = new Workspace();
        w.setName(req.name().trim());
        w.setCreatedBy(auth == null ? "system" : auth.getName());
        w.setCreatedAt(OffsetDateTime.now());
        return repo.save(w);
    }

    @DeleteMapping("/workspaces/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        if (id == 1) throw new BadRequestException("The General workspace cannot be deleted");
        repo.deleteById(id);
    }
}
