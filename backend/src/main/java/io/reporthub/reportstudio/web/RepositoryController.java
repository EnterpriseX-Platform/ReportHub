package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.service.RepositoryService;

import java.util.List;
import java.util.Map;

/**
 * Database Tool / "Repository": browse and edit the tables of any configured
 * datasource. Reads need a signed-in user; writes flow through parameterized, identifier-validated
 * statements (see {@link RepositoryService}). The SQL Editor is keyword-guarded (no DDL).
 */
@RestController
public class RepositoryController {

    public record RowWrite(String datasourceId, String schema, Map<String, Object> values) {}
    public record RowUpdate(String datasourceId, String schema, Map<String, Object> set, Map<String, Object> key) {}
    public record RowKey(String datasourceId, String schema, Map<String, Object> key) {}
    public record ExecRequest(String datasourceId, @NotBlank String sql) {}

    private final RepositoryService service;

    public RepositoryController(RepositoryService service) {
        this.service = service;
    }

    @GetMapping("/repository/tables")
    public List<RepositoryService.TableInfo> tables(@RequestParam(required = false) String datasourceId) {
        return service.tables(datasourceId);
    }

    @GetMapping("/repository/tables/{table}/meta")
    public RepositoryService.TableMeta meta(@PathVariable String table,
                                            @RequestParam(required = false) String datasourceId,
                                            @RequestParam(required = false) String schema) {
        return service.meta(datasourceId, schema, table);
    }

    @GetMapping("/repository/tables/{table}/rows")
    public RepositoryService.Rows rows(@PathVariable String table,
                                       @RequestParam(required = false) String datasourceId,
                                       @RequestParam(required = false) String schema,
                                       @RequestParam(defaultValue = "100") int limit,
                                       @RequestParam(defaultValue = "0") int offset) {
        return service.rows(datasourceId, schema, table, limit, offset);
    }

    @PostMapping("/repository/tables/{table}/rows")
    public Map<String, Integer> insert(@PathVariable String table, @RequestBody RowWrite req) {
        return Map.of("affected", service.insert(req.datasourceId(), req.schema(), table, req.values()));
    }

    @PostMapping("/repository/tables/{table}/rows/update")
    public Map<String, Integer> update(@PathVariable String table, @RequestBody RowUpdate req) {
        return Map.of("affected", service.update(req.datasourceId(), req.schema(), table, req.set(), req.key()));
    }

    @PostMapping("/repository/tables/{table}/rows/delete")
    public Map<String, Integer> delete(@PathVariable String table, @RequestBody RowKey req) {
        return Map.of("affected", service.deleteRow(req.datasourceId(), req.schema(), table, req.key()));
    }

    @PostMapping("/repository/execute")
    public RepositoryService.ExecResult execute(@Valid @RequestBody ExecRequest req) {
        return service.execute(req.datasourceId(), req.sql());
    }
}
