package io.reporthub.reportstudio.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import io.reporthub.reportstudio.dto.JobDto;
import io.reporthub.reportstudio.dto.QueueStatsDto;
import io.reporthub.reportstudio.service.QueueService;

import java.util.List;

@RestController
public class QueueController {

    private final QueueService queue;

    public QueueController(QueueService queue) {
        this.queue = queue;
    }

    @GetMapping("/jobs")
    public List<JobDto> jobs(@RequestParam(required = false) String state,
                             @RequestParam(required = false) String report,
                             @RequestParam(required = false) Integer limit) {
        return queue.list(state, report, limit);
    }

    @GetMapping("/queue/stats")
    public QueueStatsDto stats() {
        return queue.stats();
    }
}
