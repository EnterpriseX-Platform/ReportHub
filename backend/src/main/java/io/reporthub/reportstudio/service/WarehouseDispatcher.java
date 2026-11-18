package io.reporthub.reportstudio.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Fires due warehouse pipelines (those with a cron) every 30s. {@code @EnableScheduling} is already
 * declared on {@link SchedulerDispatcher}; this just adds a second timed task.
 */
/**
 * Kill switch for the Data Pipeline schedule — set app.warehouse.enabled=false and this timer is never created.
 *
 * <p>On by default (nothing set = unchanged behaviour). When off, manual "run now" from the screen still
 * works, since that path does not go through the timer.
 */
@ConditionalOnProperty(name = "app.warehouse.enabled", havingValue = "true", matchIfMissing = true)
@Component
public class WarehouseDispatcher {

    private static final Logger log = LoggerFactory.getLogger(WarehouseDispatcher.class);

    private final WarehouseService service;

    public WarehouseDispatcher(WarehouseService service) {
        this.service = service;
    }

    @Scheduled(fixedDelayString = "${app.warehouse.tick-ms:30000}", initialDelayString = "${app.warehouse.initial-delay-ms:25000}")
    public void tick() {
        try {
            int fired = service.runDue();
            if (fired > 0) log.info("Warehouse: fired {} due pipeline(s)", fired);
        } catch (Exception e) {
            log.warn("Warehouse dispatch tick failed: {}", e.getMessage());
        }
    }
}
