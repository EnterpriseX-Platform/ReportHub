# Tenants, projects and IAM integration

ReportHub can run on its own built-in users (`app.auth.mode=local`, the default) or take users,
tenants and permissions from an external **IAM service** (`app.auth.mode=iam`). Either way every
object belongs to a **tenant** and a **project**, and access is checked at three levels:

| Level | What it controls | Where it is defined |
|---|---|---|
| 1 · screen / action | which menus, screens and buttons a user gets, and which API endpoints answer | IAM objects `RH.*` with view/create/update/delete/execute/approve |
| 2 · object | which reports, datasources, datasets, tables, dashboards and report outputs a user may use | ReportHub *Access* tab (`acl_entry`) by IAM role, responsibility or user |
| 3 · row | which rows of a report, dataset or table a user sees | ReportHub *Row filters* tab (`row_filter_rule`) using IAM user attributes |

Administrators (built-in `ADMIN`, or IAM users with `isAdmin`) bypass levels 2 and 3.

## Tenants and projects

* Tables `tenant` and `project` (a project belongs to a tenant and may name the IAM Application
  code it corresponds to).
* Owned tables carry `tenant_id` + `project_id`: `report`, `report_category`, `datasource`,
  `dataset_def`, `repo_table`, `repo_folder`, `warehouse_pipeline`, `etl_chain`, `data_check`,
  `scheduler`, `dashboard`, `output_file`, `job`, `saved_view`, `workspace`, `param_def`,
  `sql_run_log`, `adhoc_run_log`, `document`, `document_asset`, plus `acl_entry` and
  `row_filter_rule`. Migrations `V64` (and `V81` for documents) backfill everything into tenant
  `default` / project `default`, so existing installs keep working.
* The tenant comes from the caller's identity (built-in users: `app_user.tenant_id`; IAM users:
  their IAM tenant, mapped through `tenant.iam_tenant_id` and created on first login when
  `app.iam.auto-provision-tenant=true`). The project is picked in the top-bar switcher and sent as
  the `X-Project` header (or `?project=` for plain links); without it the tenant's `default`
  project is used. An unknown project is a `400`.
* Scoping is automatic: while a request (or a render job, or a scheduled run) has a scope, every
  JPA query runs with the Hibernate filter `tenantScope`, new rows are stamped with the scope, and
  loading another scope's row by id answers `404`. The render worker restores the scope (and the
  submitting user, for row filters) from the job row; scheduled pipelines, checks and SQL run in
  the scope of their own row.
* The document print page (`/public/documents/{id}/print`, used by the PDF exporter) is not signed
  in; it accepts only a backend-signed, short-lived print token bound to one document id, its
  tenant/project and the requesting user, so it cannot read a document of another scope.
  Document image URLs (`/public/documents/assets/{token}`) are unguessable-token links like share
  links.
* Platform administrators (admins of tenant `default`) manage all tenants in *Settings → Tenants &
  projects*; tenant administrators manage the projects of their own tenant. A new project starts
  with a copy of the default project's report categories.

## Sign-in modes

```yaml
app:
  auth:
    mode: iam                # local (default) | iam
  iam:
    base-url: https://iam.example.org   # or Integrations → Identity (saved values win; env = defaults)
    cache-ttl-seconds: 60    # resolved permissions are reused per token for this long
    timeout-ms: 5000
    auto-provision-tenant: true
    admin-roles: RH_ADMIN,PLATFORM_ADMIN   # IAM role codes treated as ReportHub admins (default: none)
    admin-users: alice,bob                 # IAM usernames treated as ReportHub admins (default: none)
```

### ReportHub admins in IAM mode

Only users for whom IAM's `/api/auth/me` reports `isAdmin=true` are admins by default; if your IAM
does not set that flag, nobody is a ReportHub admin in IAM mode (and nobody can manage tenants/projects).
`app.iam.admin-roles` (`IAM_ADMIN_ROLES`) and `app.iam.admin-users` (`IAM_ADMIN_USERS`) are
comma-separated, case-insensitive lists; an IAM user holding one of those role codes (directly or
through a responsibility) or listed by username is a ReportHub admin (`admin=true` in `/auth/me`):
object ACLs and row filters do not apply, tenancy can be managed. Changes need a restart.

Admin-only, whatever the IAM grants say:

* `/users/**` (built-in user accounts) - ReportHub admins only, never an `RH.SETTINGS` grant. The
  list and every change are limited to the caller's tenant. Creating/changing an `ADMIN` account,
  setting or resetting passwords and deleting an `ADMIN` account need a **local** ADMIN; IAM admins
  manage `USER` accounts only. An admin password reset also lifts a sign-in lockout.
* Plugin JARs (`/engines/plugins/**`) - local ADMIN, or an IAM admin who also holds `RH.ENGINE`
  create. The JAR must contain a `META-INF/services/io.reporthub.reportstudio.engine.ReportEngine`
  entry naming at least one class.
* `POST /settings/iam/test` - admins only; returns status + a short message, never the raw body.
* A datasource whose JDBC URL is the application's own database (same host:port/database as
  `spring.datasource.url`, loopback names treated alike) cannot be created, edited or read through
  by non-admins; database-internal schemas (`pg_catalog`, `information_schema`, ...) are refused
  for non-admins in table reads and SQL previews.

`POST /auth/logout` in IAM mode also puts the IAM token on a local denylist (SHA-256 of the token,
kept until the token's `exp`, else 24 h) so the signed-out token is refused by this instance even
though IAM still considers it valid. Like the local JWT sign-out list it is in-memory per instance.

In `iam` mode `POST /api/auth/login` forwards the credentials to IAM `POST /api/auth/login` and
returns IAM's token; the UI then sends it as `Authorization: Bearer`. Any IAM token is accepted
(also IAM's `token` cookie), so a page that already holds one can call ReportHub directly. For each
new token ReportHub calls:

| IAM endpoint | Used for |
|---|---|
| `GET /api/auth/me` | token validation, user id, username, tenant, `isAdmin` |
| `GET /api/users/{id}` | `departmentCode`, `positionCode`, `employeeCode`, `email`, tenant code/name |
| `GET /api/perms/by-user` | role codes, responsibility codes and the per-object permission matrix |
| `GET /api/perms/check` | single-object checks (`IamClient.check`) |
| `GET /api/health` | *Test connection* on Integrations → Identity |

The aggregate `GET /api/perms/resolve` is grouped by role rather than by object code in the IAM
version this was built against, so the object matrix is read from `/api/perms/by-user`.

The built-in JWT and the edge-gateway token (`edge.auth.*`) keep working in both modes; built-in
users get default level-1 rights (everything except Settings/Integrations/Engines/Access changes, which stay
with `ADMIN`).

## Level 1 · object codes

Import these into one IAM module (type in parentheses is IAM's object `type`). A grant on a
parent covers its children (e.g. `RH.REPORT` covers `RH.REPORT.PARAMETER`; `RH` covers everything).

| Code | Screen / area | Actions |
|---|---|---|
| `RH` (menu) | ReportHub | view |
| `RH.OVERVIEW` (page) | Overview | view |
| `RH.REPORT` (page) | Report Registry, Run Task, versions, units, flow | view, create, update, delete, execute (run) |
| `RH.REPORT.PARAMETER` (page) | Parameters | view, create, update, delete |
| `RH.OUTPUT` (page) | Output Files | view, delete, execute (share/e-mail), approve (confirm review) |
| `RH.QUEUE` (page) | Queue Monitor | view, execute (retry/cancel) |
| `RH.INTEGRATION` (page) | Integrations: databases, identity (IAM), file storage (object store, FileHub), report engines, document exporter, notifications | view, update, execute (health check) |
| `RH.DATASOURCE` (button, parent `RH.INTEGRATION`) | Integrations → Databases (formerly Connections) | view, create, update, delete, execute (test) |
| `RH.REPOSITORY` (page) | Tables | view, create/update/delete (rows), execute (exports) |
| `RH.REPOSITORY.REGISTRY` (button) | table registry and folders | view, create, update, delete |
| `RH.ADHOC` (page) | Ad-hoc Report, saved views, SQL editor | view, create, update, delete, execute |
| `RH.DATASET` (page) | Datasets | view, create, update, delete, execute (preview/capture/query) |
| `RH.PIPELINE` (page) | Data Pipeline | view, create, update, delete, execute |
| `RH.CHAIN` (page) | Job Chains | view, create, update, delete, execute |
| `RH.CHECK` (page) | Data Checks | view, create, update, delete, execute |
| `RH.SCHEDULER` (page) | Scheduled SQL | view, create, update, delete, execute |
| `RH.DASHBOARD` (page) | Dashboards | view, create, update, delete |
| `RH.DOCUMENT` (page) | Documents: list, editor, preview | view, create (new/copy), update (save, images), delete, execute (export PDF) |
| `RH.ENGINE` (button, parent `RH.INTEGRATION`) | Integrations → Report engines (formerly Engines) | view, create, update, delete, execute (test) |
| `RH.RESOURCE` (button) | shared logos/fonts | view, create, delete |
| `RH.SETTINGS` (page) | Settings, users, tenants | view, update |
| `RH.ACCESS` (button) | Access tab: object ACLs and row filters | view, update |

`RH.DATASOURCE` and `RH.ENGINE` keep working as before: their endpoints (`/datasources/**`,
`/engines/**`) still check them, so existing grants open the Databases / Report engines categories of
Integrations (`/datasources` and `/engines` redirect there). A grant on `RH.INTEGRATION` covers both.
Connector writes on `/integrations/**` (IAM, FileHub, notifications) are ReportHub-admin only;
secrets such as the FileHub API key are stored encrypted and returned only as `••• set`. Publishing
to FileHub needs `RH.OUTPUT:execute` (outputs) or `RH.DOCUMENT:execute` (documents); the per-report
delivery setting needs `RH.REPORT:update`.

ReportHub action → IAM permission flag: `view→canView`, `create→canCreate`, `update→canEdit`,
`delete→canDelete`, `execute→canExport`, `approve→canApprove`.

Every endpoint's requirement is listed live at `GET /api/iam/endpoints` (an endpoint not listed
there only needs a signed-in user). The UI hides menu entries and buttons the user lacks, from the
matrix returned in `GET /api/auth/me` → `permissions`.

### Importing the codes into IAM

1. *Integrations → Identity → IAM → Export JSON* (or `GET /api/iam/objects/export?appCode=RH`). A copy
   of the current export is in [`docs/iam/reporthub-objects.json`](iam/reporthub-objects.json).
2. In IAM, create (or pick) the Application and a Module for ReportHub and note the module id.
3. Run the importer (Node 18+, no dependencies). It creates missing objects parents-first and
   skips codes that already exist:

   ```sh
   IAM_TOKEN=<admin token> node docs/iam/import-objects.mjs reporthub-objects.json \
     --base https://iam.example.org --module <module uuid>
   ```
4. Map the objects to roles/responsibilities with permissions in IAM as usual.

**Importer limitation.** IAM's `POST /api/objects` validates `type` against a fixed enum
(`menu`, `page`, `button`, ...) while the stored row references an object type by `objectTypeId`
(a foreign key to the IAM object-type table). The two are not kept consistent by IAM: an object
created with a valid `type` but no `objectTypeId` is accepted yet shows no type in the IAM UI, and
an `objectTypeId` whose type code is not in the enum is rejected. The importer therefore sends
both, resolving `objectTypeId` from `--types` / `IAM_OBJECT_TYPES` or the IAM API; if your IAM has
no object types for `menu`/`page`/`button`, create them first or fix the type in the IAM UI after
the import.

## Level 2 · object access

Each report, datasource, dataset, registered table, dashboard, document and report output set (`OUTPUT`,
keyed by report code) has an *Access* button. Grants are `principal_type` (`role`,
`responsibility`, `user`) + `principal_code` + `permission`:

* `view` – see it in lists and open it,
* `run` – view + run / query / export / dashboard data,
* `edit` – run + change / delete.

An object with **no grants is open** to everyone who passes level 1; with grants, only matching
principals get in. The former `report.allowed_roles` CSV was migrated to `role → run` grants and
is kept in sync when it is still sent by API clients.

API: `GET|PUT /api/acl/{type}/{id}` (body: `[{principalType, principalCode, permission}]`),
`GET /api/acl/meta`.

## Level 3 · row filters

A rule is `column operator value`, optionally limited to one role / responsibility / user.
All rules that apply to a caller are AND-ed.

* Operators: `=`, `<>`, `<`, `<=`, `>`, `>=`, `IN`, `NOT IN`, `LIKE`, `IS NULL`, `IS NOT NULL`.
* Value: literal text and/or `${user.<attribute>}`:
  `${user.departmentCode}`, `${user.positionCode}`, `${user.employeeCode}`, `${user.tenant}`,
  `${user.username}`, `${user.email}`, `${user.userId}` and any other attribute IAM returns for
  the user. Example: `ORG_CODE LIKE ${user.departmentCode}%`.
* `IN` / `NOT IN` split the resolved value on commas.
* Value type `number` binds a decimal (a non-number is rejected).
* If a referenced attribute is missing or blank the rule becomes `1=0` — the user sees **no**
  rows, never all rows.
* Column names are plain identifiers, written exactly as the query returns them (case matters on
  some databases; registered tables are matched case-insensitively against the real catalog).

Applied server-side, with every value as a bind parameter:

| Object | How |
|---|---|
| Dataset (`DATASET`, id) | `SELECT * FROM (<dataset sql or snapshot>) rf_q WHERE …` under aggregate, distinct values, export and dashboards |
| Registered table (`REPO_TABLE`, registry id) | conditions added to the table's WHERE for rows, counts, filter values, exports and export jobs; row updates/deletes are limited to rows the user can see. Rules of every registry entry pointing at the same physical table apply |
| Document table bound to a dataset | runs through the dataset's rules (and needs `run` on the dataset) in the editor, the preview and the exported PDF. The PDF print page reads data as the user who requested the export (backend `Export PDF`, or the submitter of a `docbuilder` report job): the backend signs a short-lived print token (`DOC_PRINT_KEY`, HMAC) carrying document id, tenant/project and that user, and the exporter passes it to the print page |
| Report (`REPORT`, code) | the report's SQL (unit `sql` config / statement used by the `sql` export engine and the SQL-fed Jasper path) is wrapped; values travel as `$P{__rfN}` parameters. Run as the user who submitted the job |

*Preview as user* (`POST /api/row-filters/{type}/{id}/preview`) compiles the saved rules for any
username / roles / responsibilities / attributes and returns the SQL and bind values.

API: `GET|PUT /api/row-filters/{type}/{id}` (body: `[{column, operator, valueExpr, valueType,
principalType, principalCode, enabled}]`).

## Known limits

* Report codes, datasource ids and category ids are still unique across all tenants.
* Jasper templates that run their own embedded query (`queryString` in the `.jrxml`) are not
  row-filtered; use a unit `sql` config (or a dataset) for row-filtered reports.
* Free-form SQL (Ad-hoc SQL editor, `RH.ADHOC` execute) and inserts on registered tables are not
  row-filtered — grant those only to users who may see all rows.
* Child rows (pipeline steps, run history, report units/versions) are reached through their
  scoped parent; their id-addressed history endpoints are not scope-checked on their own.
* `/api/outputs/page` filters the page after the database query, so its total can be higher than
  the rows shown when output ACLs hide some reports.
* Public share links (dashboards, saved views, output files) are token-addressed and run without a
  user, so row filters do not apply to them; share only what may be public.
* Engine instances are platform-wide. Shared resources are per tenant (`shared/` for the default
  tenant, `shared/t/<tenant>/` for others); built-in users carry a tenant and admins only see their own.

## Notes (round-1 fixes)

- The IAM client always speaks HTTP/1.1 (the IAM service does not answer the h2c upgrade).
- IAM unreachable → API answers `503` (not `401`); a suspended/inactive IAM user (`status` on
  `/api/users/{id}`) gets `403`. `POST /auth/logout` evicts the token from the permission cache.
- In IAM mode, writes on reports, datasources, engines, parameters, resources, categories and the
  repository registry are decided by the `RH.*` object/action rule table (`GET /iam/endpoints`),
  not by the local `ADMIN` role. Local mode keeps the `ADMIN` rule.
- Roles granted through responsibilities are resolved via `/api/perms/by-resp` and included in ACL
  checks. Entries with `effectiveDate` / `expireDate` are honoured on the ReportHub side.
- `POST /settings/iam/test` accepts `{"baseUrl": "..."}` to probe an unsaved URL; `ok` is true only
  for a 2xx from `/api/health`.
- `docs/iam/import-objects.mjs` resolves object type codes to IAM `objectTypeId`s
  (`--types menu=<id>,api=<id>` or `IAM_OBJECT_TYPES`, else the IAM API when it exposes one).
