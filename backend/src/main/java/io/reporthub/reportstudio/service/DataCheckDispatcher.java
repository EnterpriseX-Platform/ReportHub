package io.reporthub.reportstudio.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Fires due data checks (those with a cron) every 30s. {@code @EnableScheduling} is already
 * declared on {@link SchedulerDispatcher}; this adds one more timed task.
 *
 * <p>Offset from the warehouse tick so a check does not routinely read a table while the pipeline
 * that fills it is mid-Replace — it would count rows in a half-loaded table and report a fail
 * nobody can reproduce.
 */
/**
 * Kill switch for the Data Checks schedule — set app.checks.enabled=false and this timer is never created.
 *
 * <p>Enabled by default (nothing set = previous behaviour). When disabled, "Run now" from the screen still works
 * because that path does not go through the timer.
 */
@ConditionalOnProperty(name = "app.checks.enabled", havingValue = "true", matchIfMissing = true)
@Component
public class DataCheckDispatcher {

    private static final Logger log = LoggerFactory.getLogger(DataCheckDispatcher.class);

    private final DataCheckService service;

    public DataCheckDispatcher(DataCheckService service) {
        this.service = service;
    }

    @Scheduled(fixedDelayString = "${app.checks.tick-ms:30000}", initialDelayString = "${app.checks.initial-delay-ms:40000}")
    public void tick() {
        try {
            int fired = service.runDue();
            if (fired > 0) log.info("Checks: fired {} due check(s)", fired);
        } catch (Exception e) {
            log.warn("Check dispatch tick failed: {}", e.getMessage());
        }
    }
}
