package io.reporthub.reportstudio.dto;

import jakarta.validation.constraints.NotBlank;

/** Install/configure an engine: via remote URL/service, JAR/lib artifact, or built-in. */
public record InstallEngineRequest(
        @NotBlank String name,
        @NotBlank String kind,            // matches a ReportEngine.kind(): component | http | jasper | aspose | ...
        String installMethod,             // url | jar | lib | service | builtin
        String baseUrl,
        String authToken,
        String componentFormat,
        String artifactRef,
        String note,
        Boolean enabled
) {}
