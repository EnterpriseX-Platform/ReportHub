package io.reporthub.reportstudio.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Ticks every 30s and fires any due {@link Scheduler}s. A single in-process timer is
 * enough for this console; the per-scheduler {@code nextRunAt} guard (advanced before each run)
 * keeps a slow job from overlapping itself.
 */
@Component
@EnableScheduling
public class SchedulerDispatcher {

    private static final Logger log = LoggerFactory.getLogger(SchedulerDispatcher.class);

    private final SchedulerService service;

    public SchedulerDispatcher(SchedulerService service) {
        this.service = service;
    }

    @Scheduled(fixedDelayString = "${app.schedulers.tick-ms:30000}", initialDelayString = "${app.schedulers.initial-delay-ms:20000}")
    public void tick() {
        try {
            int fired = service.runDue();
            if (fired > 0) log.info("Schedulers: fired {} due job(s)", fired);
        } catch (Exception e) {
            log.warn("Scheduler dispatch tick failed: {}", e.getMessage());
        }
    }
}
