# Engines

Pluggable report-generation engines for Report Studio. The core (`backend/`) stays light and fast to
build; heavy engines live here as **separate modules/services** and are resolved at runtime through the
Engine Registry (`/api/engines`). Reports pick an engine by `engine` kind; the per-report **custom**
(template/id/params) is resolved separately — engine first, then custom.

```
engines/
└─ document-exporter/    ← Node + Playwright: renders built-in Documents (/print/:id) to PDF
```

### External "component" engine

The `component` engine kind is an HTTP adapter for an external rendering service (for example one
using LibreOffice or a commercial document library). That service is **not** part of this repository;
any service implementing the contract below can be plugged in.

## How a component engine plugs into Report Studio

1. Run your component service.
2. In Report Studio → **Platform › Engines → Install engine**: method **Remote URL**, kind **component**,
   base URL = the component service URL, Bearer **token from config**, component
   format `yml`.
3. Give a report `engine = component`. The gateway's `EngineResolver` routes its render jobs to
   `POST {baseUrl}/component/v1/api/export/data` with `{app, component:"yml", elements:[{id, parameters}]}`.

Other install methods are supported too: **JAR plugin** (drop a `.jar` implementing the `ReportEngine`
SPI — `ServiceLoader`), **Library/SDK** (Maven coordinate), **Service** (container URL).
