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
        // No cron = a statement that only runs when something asks it to (the Run button, or a
        // step of a chain). Requiring a schedule would have forced people to invent a fake one.
        CronExpression cx = hasCron(cron) ? parseCron(cron) : null;
        Scheduler s = new Scheduler();
        s.setName(name.trim());
        s.setDescription(description);
        s.setDatasourceId(blank(datasourceId));
        s.setSqlText(sqlText.trim());
        s.setCron(hasCron(cron) ? cron.trim() : null);
        s.setEnabled(enabled);
        s.setCreatedBy(user);
        OffsetDateTime now = OffsetDateTime.now();
        s.setCreatedAt(now);
        s.setUpdatedAt(now);
        s.setNextRunAt(enabled && cx != null ? nextFrom(cx, now) : null);
        return repo.save(s);
    }

    @Transactional
    public Scheduler update(Long id, String name, String description, String datasourceId,
                            String sqlText, String cron, boolean enabled) {
        validateDml(sqlText);
        CronExpression cx = hasCron(cron) ? parseCron(cron) : null;
        Scheduler s = require(id);
        s.setName(name.trim());
        s.setDescription(description);
        s.setDatasourceId(blank(datasourceId));
        s.setSqlText(sqlText.trim());
        s.setCron(hasCron(cron) ? cron.trim() : null);
        s.setEnabled(enabled);
        s.setUpdatedAt(OffsetDateTime.now());
        s.setNextRunAt(enabled && cx != null ? nextFrom(cx, OffsetDateTime.now()) : null);
        return repo.save(s);
    }

    @Transactional
    public Scheduler setEnabled(Long id, boolean enabled) {
        Scheduler s = require(id);
        s.setEnabled(enabled);
        s.setUpdatedAt(OffsetDateTime.now());
        s.setNextRunAt(enabled && hasCron(s.getCron())
                ? nextFrom(parseCron(s.getCron()), OffsetDateTime.now()) : null);
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
        return execute(s, "manual", user, null);
    }

    /**
     * Run as one step of a chain, for the given fiscal year. Separate trigger value so the history
     * distinguishes a step of a round from someone pressing Run.
     */
    @Transactional
    public SchedulerRun runInline(Long id, String user, String year) {
        Scheduler s = require(id);
        return execute(s, "chain", user, year);
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
            io.reporthub.reportstudio.tenancy.TenantContext.runAs(io.reporthub.reportstudio.tenancy.TenantContext.of(s.getTenantId(), s.getProjectId()),
                    () -> execute(s, "scheduled", "scheduler", null));
        }
        return due.size();
    }

    private SchedulerRun execute(Scheduler s, String trigger, String user, String year) {
        SchedulerRun run = new SchedulerRun();
        run.setSchedulerId(s.getId());
        run.setStartedAt(OffsetDateTime.now());
        run.setTrigger(trigger);
        run.setRunBy(user);
        try {
            // $YEAR4/$YEAR2 are substituted the same way pipelines and checks do it, so the same
            // statement can serve every year instead of being copied per year.
            String sql = WarehouseService.resolveYear(s.getSqlText(), year);
            boolean block = "block".equals(RepositoryService.classify(sql));
            int affected = db.withConnection(s.getDatasourceId(), false, (con) -> {
                try (PreparedStatement ps = con.prepareStatement(sql)) {
                    // A PL/SQL block reports no update count; execute() avoids the driver having
                    // to invent one, and "rows affected" is meaningless for it anyway.
                    if (block) { ps.execute(); return -1; }
                    return ps.executeUpdate();
                }
            });
            run.setStatus("ok");
            run.setAffected(affected < 0 ? null : affected);
            run.setMessage((year != null && !year.isBlank() ? "Year " + year + " · " : "")
                    + (affected < 0 ? "PL/SQL block completed" : affected + " row(s) affected"));
            s.setLastStatus("ok");
            s.setLastError(null);
            s.setLastAffected(affected);
        } catch (Exception e) {
            String msg = trunc(WarehouseService.friendly(e.getMessage()));
            run.setStatus("error");
            run.setMessage(msg);
            s.setLastStatus("error");
            s.setLastError(msg);
            s.setLastAffected(null);
        }
        run.setFinishedAt(OffsetDateTime.now());
        s.setLastRunAt(run.getStartedAt());
        repo.save(s);
        return runs.save(run);
    }

    // ---- validation --------------------------------------------------------

    /**
     * Scheduler statements must write something — reject SELECT and any DDL (reuses the editor
     * guard). A PL/SQL block counts: loading data is not always one DML statement, and a step that
     * calls a procedure or runs a cursor loop is exactly the kind of thing a chain needs to do.
     */
    static void validateDml(String sql) {
        String kind = RepositoryService.classify(sql);   // throws on DDL / multi-statement / empty
        if (!"update".equals(kind) && !"block".equals(kind)) {
            throw new BadRequestException(
                    "Statement must be INSERT / UPDATE / DELETE / MERGE or a PL/SQL block (BEGIN … END;)");
        }
    }

    static boolean hasCron(String cron) {
        return cron != null && !cron.isBlank();
    }

    static CronExpression parseCron(String cron) {
        if (cron == null || cron.isBlank()) throw new BadRequestException("A cron schedule is required");
        try {
            return io.reporthub.reportstudio.util.Cron.parse(cron);
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
