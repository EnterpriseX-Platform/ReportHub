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
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.dto.CategoryDto;
import io.reporthub.reportstudio.dto.DatasourceDto;
import io.reporthub.reportstudio.service.CatalogService;

import java.util.List;

@RestController
public class CatalogController {

    public record CreateDatasourceRequest(
            @NotBlank String id,
            @NotBlank String name,
            @NotBlank String engine,
            String host,
            String schemaName,
            String pool,
            String jdbcUrl,
            String dbUser,
            String dbPassword) {}

    /** Edit an existing datasource. dbPassword blank = keep the current one (never sent back to the UI). */
    public record UpdateDatasourceRequest(
            @NotBlank String name,
            @NotBlank String engine,
            String host,
            String schemaName,
            String jdbcUrl,
            String dbUser,
            String dbPassword) {}

    private final CatalogService catalog;

    public CatalogController(CatalogService catalog) {
        this.catalog = catalog;
    }

    @GetMapping("/categories")
    public List<CategoryDto> categories() {
        return catalog.categories();
    }

    @PostMapping("/categories")
    @ResponseStatus(HttpStatus.CREATED)
    public CategoryDto createCategory(@RequestBody CategoryDto.Request req) {
        return catalog.createCategory(req);
    }

    @PutMapping("/categories/{id}")
    public CategoryDto updateCategory(@PathVariable String id, @RequestBody CategoryDto.Request req) {
        return catalog.updateCategory(id, req);
    }

    /** 409 while reports still use the category. */
    @DeleteMapping("/categories/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteCategory(@PathVariable String id) {
        catalog.deleteCategory(id);
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.acl.AclService acl;

    @GetMapping("/datasources")
    public List<DatasourceDto> datasources() {
        List<DatasourceDto> all = acl == null ? catalog.datasources() : acl.filter("DATASOURCE", catalog.datasources(), DatasourceDto::id, "view");
        if (RepositoryController.callerIsAdmin()) return all;
        // Non-admins get id / name / engine (+ default flag) only - no host, schema or pool details.
        return all.stream().map(d -> new DatasourceDto(d.id(), d.name(), d.engine(), null, null, d.status(),
                null, null, 0, d.hasJdbc(), d.isDefault(), false)).toList();
    }

    @PostMapping("/datasources")
    @ResponseStatus(HttpStatus.CREATED)
    public DatasourceDto createDatasource(@Valid @RequestBody CreateDatasourceRequest req) {
        return catalog.createDatasource(req);
    }

    /** Config-screen save for an existing datasource (e.g. fill a missing jdbcUrl). ADMIN-only. */
    @PutMapping("/datasources/{id}")
    public DatasourceDto updateDatasource(@PathVariable String id,
                                          @Valid @RequestBody UpdateDatasourceRequest req) {
        return catalog.updateDatasource(id, req);
    }

    /** Real connectivity probe — measures latency and persists status on the row. */
    @PostMapping("/datasources/{id}/test")
    public CatalogService.DsTestResult testDatasource(@PathVariable String id) {
        return catalog.testDatasource(id);
    }

    /** Mark this datasource as the single default; returns the refreshed list. ADMIN-only. */
    @PostMapping("/datasources/{id}/default")
    public List<DatasourceDto> setDefaultDatasource(@PathVariable String id) {
        catalog.setDefault(id);
        return catalog.datasources();
    }

    /** Delete a datasource (refused while reports still use it). ADMIN-only. */
    @DeleteMapping("/datasources/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteDatasource(@PathVariable String id) {
        catalog.delete(id);
    }
}
