package io.reporthub.reportstudio;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Report Studio — report registry + render-gateway console.
 */
@SpringBootApplication
public class ReportStudioApplication {

    public static void main(String[] args) {
        SpringApplication.run(ReportStudioApplication.class, args);
    }
}
