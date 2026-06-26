# Engines

Pluggable report-generation engines for Report Studio. The core (`backend/`) stays light and fast to
build; heavy engines live here as **separate modules/services** and are resolved at runtime through the
Engine Registry (`/api/engines`). Reports pick an engine by `engine` kind; the per-report **custom**
(template/id/params) is resolved separately — engine first, then custom.

```
engines/
└─ oneweb-component/     ← the existing OneWeb "component" engine (Spring Boot)
                           maintained in its own separate repository (not published here)
```

## Build-speed decoupling (Aspose + LibreOffice)

The component engine was slow to build because two heavy things were bundled in. They are now separated:

| What | Before | After |
|---|---|---|
| **LibreOffice** (≈199 MB `.deb` tarball) | committed in the repo root, copied around | **removed from the repo** — installed at the **container layer** via `apt` (see `oneweb-component/Dockerfile`). Re-download is `.gitignore`d. |
| **Aspose** jars (`aspose-words` 16 MB + `aspose-cells` 7.9 MB) | in `src/main/resources/` → copied into `target/classes` on **every** build | moved to `oneweb-component/libs/` (out of resources). `pom.xml` `systemPath` + the `copy-libs` plugin now point at `libs/`, so they are only placed into `BOOT-INF/lib` at package time — not reprocessed as resources. |

Result: the repo dropped from **486 MB → ~46 MB**, and the build no longer recopies ~24 MB of Aspose
jars through the resources phase. **The core Report Studio build is unaffected** — `oneweb-component` is
NOT part of the core Maven build; it builds independently.

> The component engine is tied to the OneWeb/center platform (RabbitMQ, center DB, the FrontWeb app at
> `frontweb.example`) and uses LibreOffice + Aspose for rendering. Running it standalone needs those deps —
> see its `Dockerfile` and `app-config.yml`. Provide DB/queue/credentials via environment.

## How it plugs into Report Studio

1. Run the component engine (its own service) — see `oneweb-component/Dockerfile`.
2. In Report Studio → **Platform › Engines → Install engine**: method **Remote URL**, kind **component**,
   base URL = the component service URL, Bearer **token from config** (never the leaked one), component
   format `yml`.
3. Give a report `engine = component`. The gateway's `EngineResolver` routes its render jobs to
   `POST {baseUrl}/component/v1/api/export/data` with `{app, component:"yml", elements:[{id, parameters}]}`.

Other install methods are supported too: **JAR plugin** (drop a `.jar` implementing the `ReportEngine`
SPI — `ServiceLoader`), **Library/SDK** (Maven coordinate), **Service** (container URL).
