package io.reporthub.reportstudio.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
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
import io.reporthub.reportstudio.domain.EtlChain;
import io.reporthub.reportstudio.domain.EtlChainRun;
import io.reporthub.reportstudio.domain.EtlChainRunStep;
import io.reporthub.reportstudio.domain.EtlChainStep;
import io.reporthub.reportstudio.service.EtlChainService;

import java.time.OffsetDateTime;
import java.util.List;

/** ETL chains: compose ordered runs of existing pipelines and checks, and read their round history. */
@RestController
public class EtlChainController {

    public record StepDto(Long id, int stepNo, String kind, Long pipelineId, Long checkId,
                          Long schedulerId, String config, String label, String varName, String onFail) {}
    public record ChainDto(Long id, String name, String description, String folder, boolean enabled,
                           String createdBy, OffsetDateTime createdAt, List<StepDto> steps) {}
    public record RunDto(Long id, Long chainId, String fiscalYear, int roundNo, String status,
                         OffsetDateTime startedAt, OffsetDateTime finishedAt, String runBy, String message,
                         Long resumedFromRunId, int startStepNo) {}
    public record RunStepDto(Long id, int stepNo, String kind, String refName, String status,
                             Integer rowsRead, Integer rowsWritten, Integer checkCount, Boolean checkPass,
                             Integer affected, Long warehouseRunId, Long dataCheckRunId,
                             Long schedulerRunId, String message,
                             OffsetDateTime startedAt, OffsetDateTime finishedAt) {}
    public record StepRequest(String kind, Long pipelineId, Long checkId, Long schedulerId,
                              String config, String label, String varName, String onFail) {}
    public record SaveRequest(@NotBlank String name, String description, String folder,
                              Boolean enabled, List<StepRequest> steps) {}
    public record StartRequest(String year) {}

    private final EtlChainService service;

    public EtlChainController(EtlChainService service) {
        this.service = service;
    }

    @GetMapping("/etl-chains")
    public List<ChainDto> list() {
        return service.list().stream().map(c -> toDto(c, service.stepsOf(c.getId()))).toList();
    }

    /** What the step picker offers — the registry, so a new executor shows up without a UI change. */
    @GetMapping("/etl-chains/step-types")
    public List<java.util.Map<String, String>> stepTypes() {
        return service.stepTypes();
    }

    @GetMapping("/etl-chains/{id}")
    public ChainDto get(@PathVariable Long id) {
        return toDto(service.require(id), service.stepsOf(id));
    }

    @PostMapping("/etl-chains")
    @ResponseStatus(HttpStatus.CREATED)
    public ChainDto create(@Valid @RequestBody SaveRequest req, Authentication auth) {
        EtlChain saved = service.save(null, fromReq(req), stepsOf(req), user(auth));
        return toDto(saved, service.stepsOf(saved.getId()));
    }

    @PutMapping("/etl-chains/{id}")
    public ChainDto update(@PathVariable Long id, @Valid @RequestBody SaveRequest req, Authentication auth) {
        EtlChain saved = service.save(id, fromReq(req), stepsOf(req), user(auth));
        return toDto(saved, service.stepsOf(saved.getId()));
    }

    @DeleteMapping("/etl-chains/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        service.delete(id);
    }

    /** Opens a round and returns it immediately — the steps run on a worker; poll the history. */
    @PostMapping("/etl-chains/{id}/run")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public RunDto run(@PathVariable Long id, @RequestBody(required = false) StartRequest req,
                      Authentication auth) {
        return toDto(service.start(id, req == null ? null : req.year(), user(auth)));
    }

    /** Start a new round from this round's first unfinished step, so a long chain need not restart from scratch. */
    @PostMapping("/etl-chains/runs/{runId}/resume")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public RunDto resumeRun(@PathVariable Long runId, Authentication auth) {
        return toDto(service.resume(runId, user(auth)));
    }

    /** Cancel the whole round: a queued round closes immediately; a running round stops before the next step and its in-flight database step is stopped. */
    @PostMapping("/etl-chains/runs/{runId}/cancel")
    public RunDto cancelRun(@PathVariable Long runId) {
        return toDto(service.cancel(runId));
    }

    @GetMapping("/etl-chains/{id}/runs")
    public List<RunDto> runs(@PathVariable Long id, @RequestParam(defaultValue = "50") int limit) {
        return service.history(id, limit).stream().map(EtlChainController::toDto).toList();
    }

    @GetMapping("/etl-chains/runs/{runId}/steps")
    public List<RunStepDto> runSteps(@PathVariable Long runId) {
        return service.runSteps(runId).stream().map(EtlChainController::toDto).toList();
    }

    private static String user(Authentication auth) {
        return auth == null ? "system" : auth.getName();
    }

    private static EtlChain fromReq(SaveRequest r) {
        EtlChain c = new EtlChain();
        c.setName(r.name());
        c.setDescription(r.description());
        c.setFolder(r.folder());
        c.setEnabled(r.enabled() == null || r.enabled());
        return c;
    }

    private static List<EtlChainStep> stepsOf(SaveRequest r) {
        if (r.steps() == null) return List.of();
        return r.steps().stream().map(s -> {
            EtlChainStep st = new EtlChainStep();
            st.setKind(s.kind());
            st.setPipelineId(s.pipelineId());
            st.setCheckId(s.checkId());
            st.setSchedulerId(s.schedulerId());
            st.setConfig(s.config());
            st.setLabel(s.label());
            st.setVarName(s.varName());
            st.setOnFail(s.onFail());
            return st;
        }).toList();
    }

    private static ChainDto toDto(EtlChain c, List<EtlChainStep> steps) {
        return new ChainDto(c.getId(), c.getName(), c.getDescription(), c.getFolder(), c.isEnabled(),
                c.getCreatedBy(), c.getCreatedAt(),
                steps.stream().map(s -> new StepDto(s.getId(), s.getStepNo(), s.getKind(),
                        s.getPipelineId(), s.getCheckId(), s.getSchedulerId(), s.getConfig(),
                        s.getLabel(), s.getVarName(), s.getOnFail())).toList());
    }

    private static RunDto toDto(EtlChainRun r) {
        return new RunDto(r.getId(), r.getChainId(), r.getFiscalYear(), r.getRoundNo(), r.getStatus(),
                r.getStartedAt(), r.getFinishedAt(), r.getRunBy(), r.getMessage(),
                r.getResumedFromRunId(), r.getStartStepNo());
    }

    private static RunStepDto toDto(EtlChainRunStep s) {
        return new RunStepDto(s.getId(), s.getStepNo(), s.getKind(), s.getRefName(), s.getStatus(),
                s.getRowsRead(), s.getRowsWritten(), s.getCheckCount(), s.getCheckPass(),
                s.getAffected(), s.getWarehouseRunId(), s.getDataCheckRunId(), s.getSchedulerRunId(),
                s.getMessage(), s.getStartedAt(), s.getFinishedAt());
    }
}
