package io.reporthub.reportstudio.web;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
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
                             @RequestParam(required = false) Integer limit,
                             @RequestParam(required = false) Integer size) {
        return queue.list(state, report, limit != null ? limit : size);
    }

    @GetMapping("/queue/stats")
    public QueueStatsDto stats() {
        return queue.stats();
    }

    /** Plain-text run log captured for a job (download/copy from the Queue Monitor). */
    @GetMapping(value = "/jobs/{id}/log", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseEntity<String> jobLog(@PathVariable String id) {
        String log = queue.jobLog(id);
        String body = (log == null || log.isBlank())
                ? "No run log was captured for job " + id + ".\n"
                  + "A run log is captured only for jobs that fail after this feature was deployed."
                : log;
        return ResponseEntity.ok().contentType(MediaType.TEXT_PLAIN).body(body);
    }
}
