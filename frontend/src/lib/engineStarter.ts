import JSZip from "jszip";

// A ready-to-build Maven starter for a Report Studio engine plugin. The io.reporthub.reportstudio.*
// sources below are SDK stubs for compilation only — at runtime the app provides the real ones via
// parent-first classloading, so a built jar drops straight into the "Install engine" → JAR plugin flow.

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example.reportstudio</groupId>
  <artifactId>my-engine</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <build>
    <finalName>my-engine</finalName>
  </build>
</project>
`;

const MY_ENGINE = `package com.example.engine;

import io.reporthub.reportstudio.engine.EngineConfig;
import io.reporthub.reportstudio.engine.EngineProp;
import io.reporthub.reportstudio.engine.ReportEngine;
import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Sample Report Studio engine. Build with: mvn clean package
 * then upload target/my-engine.jar via the "Install engine" dialog (JAR plugin) on the Engines page.
 *
 * Download contract: your engine NEVER builds a download URL or object key. You just return a
 * RenderResult. The platform stores it into object storage (MinIO), records an OutputFile row, and
 * serves it from GET /outputs/download?key=... with a Content-Disposition attachment. You choose
 * between two shapes:
 *   1. In-memory  — new RenderResult(bytes, contentType, extension, size)            (small files)
 *   2. File-backed — RenderResult.ofFile(tempPath, contentType, extension, size)     (huge files)
 * For (2) the worker streams your temp file to storage and DELETES it for you afterwards.
 */
public class MyEngine implements ReportEngine {

    @Override
    public String kind() {
        return "myengine";
    }

    @Override
    public String label() {
        return "My sample engine";
    }

    @Override
    public RenderResult render(RenderRequest req, EngineConfig cfg) {
        Object year = req.params() == null ? "" : req.params().getOrDefault("fiscalYear", "");
        String csv = "report,year\\n" + req.code() + "," + year + "\\n";
        byte[] bytes = csv.getBytes(StandardCharsets.UTF_8);
        return new RenderResult(bytes, "text/csv; charset=UTF-8", "csv", bytes.length);
    }

    /**
     * Big-data variant: stream rows to a temp file and hand back its Path instead of a byte[],
     * so a million-row export never sits on the heap. Call this from render() when the result is
     * large. The platform uploads the file and deletes it once stored — do not delete it yourself.
     */
    @SuppressWarnings("unused")
    private RenderResult renderLarge(RenderRequest req) throws Exception {
        Path tmp = Files.createTempFile("my-engine-", ".csv");
        try (OutputStream os = Files.newOutputStream(tmp)) {
            os.write("report,row\\n".getBytes(StandardCharsets.UTF_8));
            for (int i = 1; i <= 1_000_000; i++) {
                os.write((req.code() + "," + i + "\\n").getBytes(StandardCharsets.UTF_8));
            }
        }
        return RenderResult.ofFile(tmp, "text/csv; charset=UTF-8", "csv", Files.size(tmp));
    }

    // Per-report config fields — Report Studio renders these as a form automatically.
    @Override
    public List<EngineProp> reportProps() {
        return List.of(EngineProp.report("note", "Note", "text", false, "anything"));
    }
}
`;

const SERVICES = `com.example.engine.MyEngine\n`;

const SPI_REPORT_ENGINE = `package io.reporthub.reportstudio.engine;

import io.reporthub.reportstudio.render.RenderRequest;
import io.reporthub.reportstudio.render.RenderResult;

/**
 * Report Studio engine SPI — SDK stub (compile-time only; the running app provides the real one
 * via parent-first classloading, so do not change these signatures).
 */
public interface ReportEngine {
    String kind();
    RenderResult render(RenderRequest req, EngineConfig cfg);
    default boolean requiresInstance() { return false; }
    default String label() { return kind(); }
    default java.util.List<EngineProp> instanceProps() { return java.util.List.of(); }
    default java.util.List<EngineProp> reportProps() { return java.util.List.of(); }
}
`;

const SPI_ENGINE_CONFIG = `package io.reporthub.reportstudio.engine;

import java.util.Map;

/** Installed-engine runtime config — SDK stub. */
public record EngineConfig(String baseUrl, String authToken, String componentFormat, Map<String, String> props) {
    public static final EngineConfig NONE = new EngineConfig(null, null, null, Map.of());
}
`;

const SPI_ENGINE_PROP = `package io.reporthub.reportstudio.engine;

import java.util.List;

/** One declared engine configuration field — SDK stub. */
public record EngineProp(String key, String label, String type, boolean required,
                         String placeholder, String help, List<String> options, String storedIn) {
    public static final String UNIT_CONFIG_JSON = "UNIT_CONFIG_JSON";
    public static final String INSTANCE_COLUMN = "INSTANCE_COLUMN";
    public static final String INSTANCE_PROPS = "INSTANCE_PROPS";

    public static EngineProp report(String key, String label, String type, boolean required, String placeholder) {
        return new EngineProp(key, label, type, required, placeholder, null, List.of(), UNIT_CONFIG_JSON);
    }
    public static EngineProp instanceColumn(String key, String label, String type, boolean required, String placeholder) {
        return new EngineProp(key, label, type, required, placeholder, null, List.of(), INSTANCE_COLUMN);
    }
    public static EngineProp instanceProp(String key, String label, String type, boolean required, String placeholder) {
        return new EngineProp(key, label, type, required, placeholder, null, List.of(), INSTANCE_PROPS);
    }
}
`;

const SPI_RENDER_REQUEST = `package io.reporthub.reportstudio.render;

import java.util.Map;

/** Immutable render request — SDK stub. */
public record RenderRequest(
        String code, String name, String engine, String format,
        Map<String, Object> params, String sqlStatement, String datasourceId,
        String templateKey, Map<String, String> subreports, String configJson) {
}
`;

const SPI_RENDER_RESULT = `package io.reporthub.reportstudio.render;

import java.nio.file.Path;

/**
 * Render result: document bytes + metadata — SDK stub.
 * Small artifacts ride in {@code bytes}; large ones (millions of rows) are written to a temp file
 * and returned via {@link #ofFile} so they never sit on the heap. The platform stores whichever you
 * return into object storage and serves it from GET /outputs/download — your engine builds no URL.
 */
public record RenderResult(byte[] bytes, String contentType, String extension, long sizeBytes, Path filePath) {
    /** In-memory artifact (the common case). */
    public RenderResult(byte[] bytes, String contentType, String extension, long sizeBytes) {
        this(bytes, contentType, extension, sizeBytes, null);
    }
    /** File-backed artifact: the worker streams this temp file to storage, then deletes it. */
    public static RenderResult ofFile(Path file, String contentType, String extension, long sizeBytes) {
        return new RenderResult(null, contentType, extension, sizeBytes, file);
    }
}
`;

const SPI_RENDER_EXCEPTION = `package io.reporthub.reportstudio.render;

/** Unchecked render failure — SDK stub. */
public class RenderException extends RuntimeException {
    public RenderException(String message) { super(message); }
    public RenderException(String message, Throwable cause) { super(message, cause); }
}
`;

const README = `# Report Studio — engine starter (Maven)

A minimal ReportEngine plugin you can build and drop into Report Studio.

## Build
Requires JDK 17+ and Maven.

    mvn -q clean package

Produces: target/my-engine.jar

## Install
On the Report Studio "Engines" page click "Install engine", choose the
"JAR plugin" method, and pick target/my-engine.jar. It loads immediately
(no app restart) and the engine "myengine" becomes selectable when you
register a report.

## What to edit
- src/main/java/com/example/engine/MyEngine.java — implement render(): build the
  document bytes and return new RenderResult(bytes, contentType, extension, size).
- kind() is the unique engine id used by reports.
- reportProps() declares per-report config fields (shown as a form automatically).
- instanceProps() declares install-time fields (Base URL, token, ...) — return
  requiresInstance()=true for remote engines that need them.

## How the generated file gets downloaded
Your engine never builds a download path or URL. render() just returns a
RenderResult and the platform does the rest:

- Small result: return new RenderResult(bytes, contentType, extension, size).
- Large result (e.g. a million-row export): write to a temp file and return
  RenderResult.ofFile(tempPath, contentType, extension, size). The render worker
  streams that temp file to object storage and DELETES it for you — do not delete
  it yourself. See renderLarge() in MyEngine.java for the pattern.

Either way the worker assigns the object key, stores the artifact (MinIO), records
an OutputFile row, and serves it from GET /outputs/download?key=... with a
Content-Disposition attachment. The "extension" you return drives the filename and
the "contentType" drives the download MIME type.

## About the io.reporthub.reportstudio.* sources
The interfaces under src/main/java/io/reporthub/reportstudio are SDK stubs for
compilation only. At runtime the Report Studio app provides the real classes
(parent-first classloading), so your jar never ships a conflicting copy.
`;

const FILES: Record<string, string> = {
  "pom.xml": POM,
  "README.md": README,
  "src/main/resources/META-INF/services/io.reporthub.reportstudio.engine.ReportEngine": SERVICES,
  "src/main/java/com/example/engine/MyEngine.java": MY_ENGINE,
  "src/main/java/io/reporthub/reportstudio/engine/ReportEngine.java": SPI_REPORT_ENGINE,
  "src/main/java/io/reporthub/reportstudio/engine/EngineConfig.java": SPI_ENGINE_CONFIG,
  "src/main/java/io/reporthub/reportstudio/engine/EngineProp.java": SPI_ENGINE_PROP,
  "src/main/java/io/reporthub/reportstudio/render/RenderRequest.java": SPI_RENDER_REQUEST,
  "src/main/java/io/reporthub/reportstudio/render/RenderResult.java": SPI_RENDER_RESULT,
  "src/main/java/io/reporthub/reportstudio/render/RenderException.java": SPI_RENDER_EXCEPTION,
};

/** Build the Maven engine-starter project as a .zip and trigger a browser download. */
export async function downloadEngineStarter(): Promise<void> {
  const zip = new JSZip();
  const root = zip.folder("report-studio-engine-starter")!;
  for (const [path, content] of Object.entries(FILES)) root.file(path, content);
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "report-studio-engine-starter.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
