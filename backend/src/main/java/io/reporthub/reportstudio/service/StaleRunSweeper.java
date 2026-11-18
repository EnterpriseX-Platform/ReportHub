package io.reporthub.reportstudio.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.repo.DataCheckRepository;
import io.reporthub.reportstudio.repo.DataCheckRunRepository;
import io.reporthub.reportstudio.repo.EtlChainRunRepository;
import io.reporthub.reportstudio.repo.EtlChainRunStepRepository;
import io.reporthub.reportstudio.repo.WarehousePipelineRepository;
import io.reporthub.reportstudio.repo.WarehouseRunRepository;

import java.time.OffsetDateTime;

/**
 * Closes runs that were still in flight when the process last stopped.
 *
 * <p>Pipeline and check runs execute on an in-process worker, so a deploy or a pod restart kills
 * them with their row still saying {@code running}. Nothing ever comes back to finish that row, and
 * a screen cannot tell "running since a minute ago" from "abandoned yesterday" — it just spins.
 * Anything left running when this process starts therefore belongs to a previous life and is closed
 * as an error, which is the honest reading: the work did not finish and nobody knows how far it got.
 */
@Component
public class StaleRunSweeper {

    private static final Logger log = LoggerFactory.getLogger(StaleRunSweeper.class);
    private static final String MSG = "Interrupted — the service restarted while this was running. You can run it again.";

    private final WarehouseRunRepository wRuns;
    private final WarehousePipelineRepository pipelines;
    private final DataCheckRunRepository cRuns;
    private final DataCheckRepository checks;
    private final EtlChainRunRepository chainRuns;
    private final EtlChainRunStepRepository chainSteps;

    public StaleRunSweeper(WarehouseRunRepository wRuns, WarehousePipelineRepository pipelines,
                           DataCheckRunRepository cRuns, DataCheckRepository checks,
                           EtlChainRunRepository chainRuns, EtlChainRunStepRepository chainSteps) {
        this.wRuns = wRuns;
        this.pipelines = pipelines;
        this.cRuns = cRuns;
        this.checks = checks;
        this.chainRuns = chainRuns;
        this.chainSteps = chainSteps;
    }

    @EventListener(ApplicationReadyEvent.class)
    @Transactional
    public void sweep() {
        int n = 0;
        OffsetDateTime now = OffsetDateTime.now();
        for (var r : wRuns.findAll()) {
            // queued must be closed too — the queue is in-memory, so waiting jobs vanished with the process
            if (!"running".equals(r.getStatus()) && !"queued".equals(r.getStatus())) continue;
            r.setStatus("error");
            r.setMessage(MSG);
            r.setFinishedAt(now);
            wRuns.save(r);
            pipelines.findById(r.getPipelineId()).ifPresent(p -> {
                if ("running".equals(p.getLastStatus()) || "queued".equals(p.getLastStatus())) {
                    p.setLastStatus("error"); p.setLastError(MSG); pipelines.save(p);
                }
            });
            n++;
        }
        for (var r : cRuns.findAll()) {
            if (!"running".equals(r.getStatus())) continue;
            r.setStatus("error");
            r.setMessage(MSG);
            r.setFinishedAt(now);
            cRuns.save(r);
            checks.findById(r.getCheckId()).ifPresent(c -> {
                if ("running".equals(c.getLastStatus())) { c.setLastStatus("error"); c.setLastError(MSG); checks.save(c); }
            });
            n++;
        }
        // chain: a run stuck in running is not just cosmetic — the screen disables "Run all" while any
        // run is still active, so a run cut off by a restart would lock that chain forever unless closed
        for (var r : chainRuns.findAll()) {
            if (!"running".equals(r.getStatus()) && !"queued".equals(r.getStatus())) continue;
            r.setStatus("failed");
            r.setMessage(MSG);
            r.setFinishedAt(now);
            chainRuns.save(r);
            for (var st : chainSteps.findByRunIdOrderByStepNoAsc(r.getId())) {
                if (!"running".equals(st.getStatus())) continue;
                st.setStatus("failed");
                st.setMessage(MSG);
                st.setFinishedAt(now);
                chainSteps.save(st);
            }
            n++;
        }
        if (n > 0) log.info("Closed {} job(s) left over from the previous instance", n);
    }
}
