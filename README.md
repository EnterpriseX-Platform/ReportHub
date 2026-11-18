# Report Studio

Full-stack implementation of the report registry & gateway console.

```
report-studio/
├─ backend/    Spring Boot 3.3 (Java 17) + JPA + Flyway + Postgres job queue + MinIO + JWT → PostgreSQL
│              (light core — pluggable engine registry; NO Aspose/LibreOffice)
├─ frontend/   Next.js 15 (App Router, TS) — Carbon-based design system
├─ engines/    installable report engines (separate builds, opt-in) — see engines/README.md
└─ docker-compose.yml   PostgreSQL · MinIO
```

**Engines are pluggable.** The light core resolves an engine, then the per-report custom separately.
Install engines at **Platform › Engines** via Remote URL / Service / JAR plugin (`ReportEngine` SPI) /
Library. Heavy renderers (e.g. LibreOffice-based) run as separate services behind the
`component` / `api` engine kinds — see [`engines/`](engines/README.md).

## Stack

| Tier | Tech |
|---|---|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind |
| Backend | Spring Boot 3.3, Spring Data JPA, Flyway, Bean Validation |
| Database | PostgreSQL 16 |
| Gateway/queue | Postgres-backed job queue (`job` table, `FOR UPDATE SKIP LOCKED`), polled by the worker |

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

## What works now

The frontend uses a Console-light skin, azure-cyan accent and IBM Plex fonts.

- **Dashboard** — coverage donut, status & engine breakdown, live queue, recently-updated table
- **Report Registry** — category rail, search + status/engine filters, **detail slide-over** (Overview / **YAML config** / Parameters / Versions timeline / History), **Register wizard** (4 steps, persists to DB), **Import config** (YAML parse + validate + register)
- **Tester & Preview** — report picker, parameter form, simulated run with phased log + **PDF/Excel preview**
- **Output Files** — artifact browser (list/grid) + preview modal
- **Queue Monitor** — live render pipeline diagram, animated job stream, queue backlog/workers, job-trace slide-over
- **Datasources** — connection cards, health, test-connection, detail slide-over
- **Ad-hoc Builder** — guided flow, dataset/field/condition steps, result table, Excel export, saved queries + history
- **Analytics Workbench** — drag-to-shelf pivot over the fact warehouse, subtotals, heatmap, grand total

## Data & operations features

- **SQL runner** — CodeMirror SQL editor with formatting, run history, saved scripts in folders, and
  export of results; browse/edit tables in the repository (`/repository/*`).
- **Data warehouse pipelines** — step-based ETL pipelines with enable/disable, manual or scheduled
  runs, per-step run logs and cancellation (`/warehouse/*`).
- **ETL chains** — ordered sequences of pipelines with run history, cancel and resume (`/etl-chains/*`).
- **Data checks** — SQL-based data quality rules grouped in folders; run on demand, view history and
  the offending rows, export findings (`/checks/*`).
- **Ops panel** — queue/worker status and recent runs at a glance; rendering can run in a separate
  worker deployment (`k8s/35-worker.yaml`, check the queue with `k8s/queue-check.sh` before deploying).
- **Dashboards & saved views** — shareable dashboards (including public links), header filters,
  big-number tiles, donut, tree and a region **choropleth map** (GeoJSON in `frontend/public/geo/`).
- **Export library** — `rs-export.js`, a dependency-free "Export report" drawer other web apps can
  include; see [`docs/rs-export-library.md`](docs/rs-export-library.md).

## Tenants, projects and IAM

ReportHub is multi-tenant: every report, datasource, dataset, table, pipeline, check, schedule,
dashboard, output and job belongs to a **tenant** and a **project** (existing data lands in
`default` / `default`). The project is picked in the top-bar switcher; the tenant comes from the
signed-in user.

Sign-in is either built-in (`APP_AUTH_MODE=local`, default) or delegated to an external IAM service
(`APP_AUTH_MODE=iam`, `IAM_BASE_URL=…` or *Integrations → Identity*). Access is checked at three
levels: IAM object codes for screens and actions (`RH.REPORT`, `RH.DATASET`, …), per-object grants
by IAM role / responsibility / user (the *Access* button on reports, datasources, datasets, tables,
dashboards and outputs), and row filters driven by IAM user attributes
(`${user.departmentCode}`, …) applied server-side with bind parameters.

Object code list, import script and rule syntax: [docs/iam-integration.md](docs/iam-integration.md).

## API (implemented)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/dashboard/summary` | stats + breakdowns + recent |
| GET | `/api/categories` | 9 report categories + registered counts |
| GET | `/api/datasources` | database connections + report counts |
| GET | `/api/integrations` | all integrations by category (databases, identity, file storage, report engines, exporter, notifications); secrets masked |
| PUT/POST/DELETE | `/api/integrations[/{id}]` | save IAM / notification / FileHub connectors (ReportHub admin) |
| POST | `/api/integrations/{id}/test` | health check (typed values or saved ones) |
| POST | `/api/outputs/filehub?key=` · `/api/outputs/filehub/bulk` · `/api/documents/{id}/filehub` | publish to FileHub |
| GET/PUT | `/api/reports/{code}/delivery` | per-report "Deliver to FileHub" (connector + folder template `{code}/{yyyy}/{mm}`) |
| GET | `/api/reports` | `?category=&status=&engine=&datasource=&q=&page=&size=&sort=` (paged) |
| GET | `/api/reports/{code}` | report detail |
| POST | `/api/reports` | register (wizard / import) → persists report + version |
| GET | `/api/jobs` | `?state=&limit=` gateway jobs |
| GET | `/api/queue/stats` | active count + pipeline stage counts |

## Roadmap (next phases)

3. Worker pool scaling (multiple worker replicas share the Postgres queue), versioning/rollback persistence, audit log
4. Engine connectors: API / SQL / Composite execution
5. Real output store (S3/MinIO) + signed-URL download; server-side Ad-hoc/pivot + true `.xlsx` export
6. RBAC enforcement (Report Admin / Report Analyst), OIDC SSO
7. Bulk import of report configurations

