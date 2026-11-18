package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.dto.ParamDefDto;
import io.reporthub.reportstudio.dto.ParamOptionDto;
import io.reporthub.reportstudio.dto.SaveParamRequest;
import io.reporthub.reportstudio.service.ParameterService;

import java.util.List;

/** Parameter catalog: definitions, table-driven options (with cascade), per-report assignment. */
@RestController
public class ParameterController {

    private final ParameterService params;

    public ParameterController(ParameterService params) {
        this.params = params;
    }

    @GetMapping("/parameters")
    public List<ParamDefDto> list() {
        return params.list();
    }

    @PostMapping("/parameters")
    @ResponseStatus(HttpStatus.CREATED)
    public ParamDefDto create(@Valid @RequestBody SaveParamRequest req) {
        return params.create(req);
    }

    @PutMapping("/parameters/{id}")
    public ParamDefDto update(@PathVariable Long id, @Valid @RequestBody SaveParamRequest req) {
        return params.update(id, req);
    }

    @DeleteMapping("/parameters/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        params.delete(id);
    }

    /** Internal-warehouse tables usable as lookup sources (for the catalog UI). */
    @GetMapping("/parameters/lookup-tables")
    public List<String> lookupTables() {
        return params.lookupTables();
    }

    @GetMapping("/parameters/lookup-tables/{table}/columns")
    public List<String> tableColumns(@PathVariable String table) {
        return params.tableColumns(table);
    }

    /** Resolve options for an UNSAVED definition — the editor's "Preview options" button. */
    @PostMapping("/parameters/preview-options")
    public List<ParamOptionDto> previewOptions(@Valid @RequestBody SaveParamRequest req,
                                               @RequestParam(required = false) String parent) {
        return params.previewOptions(req, parent);
    }

    /** Dropdown options; pass {@code parent} when the parameter depends on another one. */
    @GetMapping("/parameters/{name}/options")
    public List<ParamOptionDto> options(@PathVariable String name,
                                        @RequestParam(required = false) String parent) {
        return params.options(name, parent);
    }

    // ---- per-report assignment ----

    @GetMapping("/reports/{code}/parameters")
    public List<ParamDefDto> forReport(@PathVariable String code) {
        return params.forReport(code);
    }

    @PutMapping("/reports/{code}/parameters")
    public List<ParamDefDto> assign(@PathVariable String code,
                                    @RequestBody List<io.reporthub.reportstudio.dto.ReportParamAssignment> items) {
        return params.assign(code, items);
    }
}
