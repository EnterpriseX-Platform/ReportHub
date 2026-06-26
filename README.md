# Report Studio

Full-stack implementation of the report registry & gateway console.
This repo is the **real application** built from the prototype in [`design_handoff_report_studio/`](design_handoff_report_studio/) (kept as design reference).

```
report-studio/
├─ backend/    Spring Boot 3.3 (Java 17) + JPA + Flyway + Kafka gateway + MinIO + JWT → PostgreSQL
│              (light core — pluggable engine registry; NO Aspose/LibreOffice)
├─ frontend/   Next.js 15 (App Router, TS) — design system ported from the prototype
├─ engines/    installable report engines (separate builds, opt-in) — see engines/README.md
│              └─ oneweb-component/   the existing OneWeb "component" engine (Aspose/LibreOffice, decoupled)
├─ docker-compose.yml   PostgreSQL · Kafka · MinIO  (+ component-engine under `--profile engines`)
└─ design_handoff_report_studio/   original HTML/React prototype + handoff spec
```

**Engines are pluggable.** The light core resolves an engine, then the per-report custom separately.
Install engines at **Platform › Engines** via Remote URL / Service / JAR plugin (`ReportEngine` SPI) /
Library. The real OneWeb **component** engine is merged under [`engines/`](engines/README.md) with its
heavy Aspose + LibreOffice deps split out so the core build stays fast.

## Stack

| Tier | Tech |
|---|---|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind (tokens ported from prototype) |
| Backend | Spring Boot 3.3, Spring Data JPA, Flyway, Bean Validation |
| Database | PostgreSQL 16 |
| Gateway/queue | **Phase 3** — Kafka (run service is behind an interface now, synchronous) |

## Run locally

Three terminals (DB → backend → frontend).

### 1. Database
```bash
docker compose up -d postgres        # or: docker compose up -d  (also starts Adminer on :8081)
```
Postgres is published on host port **5433** (container 5432) to avoid clashing with a local
Postgres on 5432. Override with `DB_URL` if you run it elsewhere.

### 2. Backend  (http://localhost:8080/api)
```bash
cd backend
mvn spring-boot:run
```
Flyway runs `V1__schema.sql` + `V2__seed.sql` on first boot — seeds 9 report categories
(required min = 265) + 6 datasources + 24 sample reports.

Smoke test:
```bash
curl http://localhost:8080/api/dashboard/summary
curl 'http://localhost:8080/api/reports?category=c4&status=active'
```

### 3. Frontend  (http://localhost:3000)
```bash
cd frontend
cp .env.local.example .env.local     # NEXT_PUBLIC_API_BASE=http://localhost:8080/api
npm install
npm run dev
```

## What works now (all 8 modules — verified end-to-end via Chrome MCP)

The frontend ports the approved prototype design system (`styles.css`) verbatim — Console-light skin,
azure-cyan accent, IBM Plex fonts — so the theme/UX matches the prototype exactly.

- **Dashboard** — coverage donut, status & engine breakdown, live queue, recently-updated table
- **Report Registry** — category rail, search + status/engine filters, **detail slide-over** (Overview / **YAML config** / Parameters / Versions timeline / History), **Register wizard** (4 steps, persists to DB), **Import config** (YAML parse + validate + register)
- **Tester & Preview** — report picker, parameter form, simulated run with phased log + **PDF/Excel preview**
- **Output Files** — artifact browser (list/grid) + preview modal
- **Queue Monitor** — live Kafka pipeline diagram, animated job stream, partitions/consumers, job-trace slide-over
- **Datasources** — connection cards, health, test-connection, detail slide-over
- **Ad-hoc Builder** — guided flow, dataset/field/condition steps, result table, Excel export, saved queries + history
- **Analytics Workbench** — drag-to-shelf pivot over the fact warehouse, subtotals, heatmap, grand total

## API (implemented)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/dashboard/summary` | stats + breakdowns + recent |
| GET | `/api/categories` | 9 report categories + registered counts |
| GET | `/api/datasources` | connections + report counts |
| GET | `/api/reports` | `?category=&status=&engine=&datasource=&q=&page=&size=&sort=` (paged) |
| GET | `/api/reports/{code}` | report detail |
| POST | `/api/reports` | register (wizard / import) → persists report + version |
| GET | `/api/jobs` | `?state=&limit=` gateway jobs |
| GET | `/api/queue/stats` | active count + pipeline stage counts |

## Roadmap (next phases)

3. Real Kafka gateway + worker pool (replace the in-UI simulation), versioning/rollback persistence, audit log
4. Engine connectors: API / SQL / Composite execution
5. Real output store (S3/MinIO) + signed-URL download; server-side Ad-hoc/pivot + true `.xlsx` export
6. RBAC enforcement (Report Admin / Report Analyst), OIDC SSO
7. Import config to reach ≥265 reports across all categories

See [`design_handoff_report_studio/README.md`](design_handoff_report_studio/README.md) for the full spec & data contracts.
