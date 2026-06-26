package io.reporthub.reportstudio.service;

import org.springframework.scheduling.support.CronExpression;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Scheduler;
import io.reporthub.reportstudio.domain.SchedulerRun;
import io.reporthub.reportstudio.repo.SchedulerRepository;
import io.reporthub.reportstudio.repo.SchedulerRunRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.NotFoundException;

import java.sql.PreparedStatement;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.util.List;

/**
 * Scheduled SQL jobs. A {@link Scheduler} holds a single DML statement, a cron, and an
 * enabled flag; {@link #runDue()} (driven by {@link SchedulerDispatcher}) fires the ones whose
 * {@code nextRunAt} has passed, and {@link #runNow} handles the manual "Run" button. Every run is
 * recorded in {@code scheduler_run} and summarized on the scheduler row.
 */
@Service
public class SchedulerService {

    private final SchedulerRepository repo;
    private final SchedulerRunRepository runs;
    private final DbConnections db;

    public SchedulerService(SchedulerRepository repo, SchedulerRunRepository runs, DbConnections db) {
        this.repo = repo;
        this.runs = runs;
        this.db = db;
    }

    @Transactional(readOnly = true)
    public List<Scheduler> list() {
        return repo.findAllByOrderByCreatedAtDesc();
    }

    @Transactional(readOnly = true)
    public Scheduler require(Long id) {
        return repo.findById(id).orElseThrow(() -> new NotFoundException("Scheduler not found: " + id));
    }

    @Transactional(readOnly = true)
    public List<SchedulerRun> history(Long id, int limit) {
        require(id);
        return runs.findBySchedulerIdOrderByStartedAtDesc(id,
                org.springframework.data.domain.PageRequest.of(0, Math.min(Math.max(limit, 1), 200)));
    }

    @Transactional
    public Scheduler create(String name, String description, String datasourceId, String sqlText,
                            String cron, boolean enabled, String user) {
        validateDml(sqlText);
        CronExpression cx = parseCron(cron);
        Scheduler s = new Scheduler();
        s.setName(name.trim());
        s.setDescription(description);
        s.setDatasourceId(blank(datasourceId));
        s.setSqlText(sqlText.trim());
        s.setCron(cron.trim());
        s.setEnabled(enabled);
        s.setCreatedBy(user);
        OffsetDateTime now = OffsetDateTime.now();
        s.setCreatedAt(now);
        s.setUpdatedAt(now);
        s.setNextRunAt(enabled ? nextFrom(cx, now) : null);
        return repo.save(s);
    }

    @Transactional
    public Scheduler update(Long id, String name, String description, String datasourceId,
                            String sqlText, String cron, boolean enabled) {
        validateDml(sqlText);
        CronExpression cx = parseCron(cron);
        Scheduler s = require(id);
        s.setName(name.trim());
        s.setDescription(description);
        s.setDatasourceId(blank(datasourceId));
        s.setSqlText(sqlText.trim());
        s.setCron(cron.trim());
        s.setEnabled(enabled);
        s.setUpdatedAt(OffsetDateTime.now());
        s.setNextRunAt(enabled ? nextFrom(cx, OffsetDateTime.now()) : null);
        return repo.save(s);
    }

    @Transactional
    public Scheduler setEnabled(Long id, boolean enabled) {
        Scheduler s = require(id);
        s.setEnabled(enabled);
        s.setUpdatedAt(OffsetDateTime.now());
        s.setNextRunAt(enabled ? nextFrom(parseCron(s.getCron()), OffsetDateTime.now()) : null);
        return repo.save(s);
    }

    @Transactional
    public void delete(Long id) {
        Scheduler s = require(id);
        runs.deleteBySchedulerId(id);
        repo.delete(s);
    }

    /** Manual "Run" button. */
    @Transactional
    public SchedulerRun runNow(Long id, String user) {
        Scheduler s = require(id);
        return execute(s, "manual", user);
    }

    /** Fire every enabled scheduler whose nextRunAt has passed; recompute the next fire time. */
    @Transactional
    public int runDue() {
        OffsetDateTime now = OffsetDateTime.now();
        List<Scheduler> due = repo.findByEnabledTrueAndNextRunAtLessThanEqual(now);
        for (Scheduler s : due) {
            // advance nextRunAt FIRST so a slow/overlapping run can't be picked up twice
            s.setNextRunAt(nextFrom(parseCron(s.getCron()), now));
            repo.save(s);
            execute(s, "scheduled", "scheduler");
        }
        return due.size();
    }

    private SchedulerRun execute(Scheduler s, String trigger, String user) {
        SchedulerRun run = new SchedulerRun();
        run.setSchedulerId(s.getId());
        run.setStartedAt(OffsetDateTime.now());
        run.setTrigger(trigger);
        run.setRunBy(user);
        try {
            int affected = db.withConnection(s.getDatasourceId(), false, (con) -> {
                try (PreparedStatement ps = con.prepareStatement(s.getSqlText())) {
                    return ps.executeUpdate();
                }
            });
            run.setStatus("ok");
            run.setAffected(affected);
            run.setMessage(affected + " row(s) affected");
            s.setLastStatus("ok");
            s.setLastError(null);
            s.setLastAffected(affected);
        } catch (Exception e) {
            run.setStatus("error");
            run.setMessage(trunc(e.getMessage()));
            s.setLastStatus("error");
            s.setLastError(trunc(e.getMessage()));
            s.setLastAffected(null);
        }
        run.setFinishedAt(OffsetDateTime.now());
        s.setLastRunAt(run.getStartedAt());
        repo.save(s);
        return runs.save(run);
    }

    // ---- validation --------------------------------------------------------

    /** Scheduler statements must be writes — reject SELECT and any DDL (reuses the editor guard). */
    static void validateDml(String sql) {
        String kind = RepositoryService.classify(sql);   // throws on DDL / multi-statement / empty
        if (!"update".equals(kind)) {
            throw new BadRequestException("A scheduler must run an INSERT / UPDATE / DELETE / MERGE statement");
        }
    }

    static CronExpression parseCron(String cron) {
        if (cron == null || cron.isBlank()) throw new BadRequestException("A cron schedule is required");
        try {
            return CronExpression.parse(cron.trim());
        } catch (IllegalArgumentException e) {
            throw new BadRequestException("Invalid cron expression: " + e.getMessage());
        }
    }

    private static OffsetDateTime nextFrom(CronExpression cx, OffsetDateTime from) {
        ZonedDateTime next = cx.next(from.toZonedDateTime());
        return next == null ? null : next.toOffsetDateTime();
    }

    private static String blank(String s) { return (s == null || s.isBlank()) ? null : s.trim(); }

    private static String trunc(String s) {
        if (s == null) return null;
        return s.length() > 4000 ? s.substring(0, 4000) : s;
    }
}
