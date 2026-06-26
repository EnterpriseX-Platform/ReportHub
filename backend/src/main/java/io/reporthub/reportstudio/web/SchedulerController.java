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
import io.reporthub.reportstudio.domain.Scheduler;
import io.reporthub.reportstudio.domain.SchedulerRun;
import io.reporthub.reportstudio.service.SchedulerService;

import java.time.OffsetDateTime;
import java.util.List;

/** Scheduled SQL jobs: CRUD, enable/disable, manual run, and run history. */
@RestController
public class SchedulerController {

    public record SchedulerDto(Long id, String name, String description, String datasourceId,
                               String sqlText, String cron, boolean enabled,
                               OffsetDateTime nextRunAt, OffsetDateTime lastRunAt,
                               String lastStatus, String lastError, Integer lastAffected,
                               String createdBy, OffsetDateTime createdAt) {}
    public record RunDto(Long id, Long schedulerId, OffsetDateTime startedAt, OffsetDateTime finishedAt,
                         String status, String trigger, Integer affected, String message, String runBy) {}
    public record SaveSchedulerRequest(@NotBlank String name, String description, String datasourceId,
                                       @NotBlank String sqlText, @NotBlank String cron, Boolean enabled) {}
    public record ToggleRequest(boolean enabled) {}

    private final SchedulerService service;

    public SchedulerController(SchedulerService service) {
        this.service = service;
    }

    @GetMapping("/schedulers")
    public List<SchedulerDto> list() {
        return service.list().stream().map(SchedulerController::toDto).toList();
    }

    @GetMapping("/schedulers/{id}")
    public SchedulerDto get(@PathVariable Long id) {
        return toDto(service.require(id));
    }

    @PostMapping("/schedulers")
    @ResponseStatus(HttpStatus.CREATED)
    public SchedulerDto create(@Valid @RequestBody SaveSchedulerRequest req, Authentication auth) {
        return toDto(service.create(req.name(), req.description(), req.datasourceId(), req.sqlText(),
                req.cron(), req.enabled() == null || req.enabled(), auth == null ? "system" : auth.getName()));
    }

    @PutMapping("/schedulers/{id}")
    public SchedulerDto update(@PathVariable Long id, @Valid @RequestBody SaveSchedulerRequest req) {
        return toDto(service.update(id, req.name(), req.description(), req.datasourceId(), req.sqlText(),
                req.cron(), req.enabled() == null || req.enabled()));
    }

    @PostMapping("/schedulers/{id}/toggle")
    public SchedulerDto toggle(@PathVariable Long id, @RequestBody ToggleRequest req) {
        return toDto(service.setEnabled(id, req.enabled()));
    }

    @PostMapping("/schedulers/{id}/run")
    public RunDto run(@PathVariable Long id, Authentication auth) {
        return toRunDto(service.runNow(id, auth == null ? "system" : auth.getName()));
    }

    @GetMapping("/schedulers/{id}/runs")
    public List<RunDto> runs(@PathVariable Long id, @RequestParam(defaultValue = "30") int limit) {
        return service.history(id, limit).stream().map(SchedulerController::toRunDto).toList();
    }

    @DeleteMapping("/schedulers/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        service.delete(id);
    }

    private static SchedulerDto toDto(Scheduler s) {
        return new SchedulerDto(s.getId(), s.getName(), s.getDescription(), s.getDatasourceId(),
                s.getSqlText(), s.getCron(), s.isEnabled(), s.getNextRunAt(), s.getLastRunAt(),
                s.getLastStatus(), s.getLastError(), s.getLastAffected(), s.getCreatedBy(), s.getCreatedAt());
    }

    private static RunDto toRunDto(SchedulerRun r) {
        return new RunDto(r.getId(), r.getSchedulerId(), r.getStartedAt(), r.getFinishedAt(),
                r.getStatus(), r.getTrigger(), r.getAffected(), r.getMessage(), r.getRunBy());
    }
}
