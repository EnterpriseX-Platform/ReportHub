package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
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

    private final CatalogService catalog;

    public CatalogController(CatalogService catalog) {
        this.catalog = catalog;
    }

    @GetMapping("/categories")
    public List<CategoryDto> categories() {
        return catalog.categories();
    }

    @GetMapping("/datasources")
    public List<DatasourceDto> datasources() {
        return catalog.datasources();
    }

    @PostMapping("/datasources")
    @ResponseStatus(HttpStatus.CREATED)
    public DatasourceDto createDatasource(@Valid @RequestBody CreateDatasourceRequest req) {
        return catalog.createDatasource(req);
    }

    /** Real connectivity probe — measures latency and persists status on the row. */
    @PostMapping("/datasources/{id}/test")
    public CatalogService.DsTestResult testDatasource(@PathVariable String id) {
        return catalog.testDatasource(id);
    }
}
