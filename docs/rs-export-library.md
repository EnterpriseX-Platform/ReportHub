# rs-export.js — "Export report" button for host web apps

A single shared library that any web app can include to ask Report Studio to render a report and
hand back the file, **without writing any backend code in that app**.

The file lives at `frontend/public/rs-export.js`; Next.js serves it statically at
`{basePath}/rs-export.js` = **`https://<host>/reportstudio/rs-export.js`**
(update it in one place and every app picks up the new version).

---

## 1. Include (one line)

```html
<script src="/reportstudio/rs-export.js"></script>
```

**Use a root-relative URL.** When `/reportstudio` is served from the same host as the app in every
environment, no per-environment config is needed and API calls are **same-origin** (no CORS).

## 2. Mount a button

```html
<div id="rsExportHost"></div>
<script>
  RSExport.mount({
    target: '#rsExportHost',
    reportCode: 'SALES_RPT01_XLSX',
    permission: { componentId: 'sales.export' },
    defaults: { <param>: '<value>' }
  });
</script>
```

`mount()` returns `null` and **does not touch the DOM** when the user lacks permission, so it can be
called unconditionally.

To keep a page's existing button, wire `open()` yourself:

```html
<button class="btn_export" onclick="RSExport.open({ reportCode:'SALES_RPT01_XLSX' })">Export report</button>
```

## 3. What the drawer does

Clicking the button slides a drawer in from the right, then:

1. `GET /reports/{code}` + `GET /reports/{code}/parameters` -> **lists the parameters automatically**
   (same semantics as Report Studio's Run Task screen):
   - `enum` / `boolean` / `staticOptions` / `sourceType=query|sql` -> dropdown
   - `dependsOn` -> cascade: options reload from `GET /parameters/{name}/options?parent=` when the
     parent changes, disabled until the parent has a value
   - required = `requiredOverride ?? required` (validated before submitting)
   - `defaultValue` is prefilled (overridable via `defaults`)
2. Pick a **file format** from `report.formats`.
3. **Download report** ->
   `POST /reports/{code}/run` -> **`jobId`** -> poll `GET /jobs/{id}` -> `done` ->
   `GET /jobs/{id}/output/download` -> save the file.
4. **The Job number is shown prominently** with a progress bar and a **"Recent jobs"** list
   (kept in `localStorage`), so for large/slow reports the user can **close the drawer** and
   download later from the same Job number.

## 4. Permission (who sees the button)

`permission` accepts three forms (checked in order):

| Form | Use when |
|---|---|
| `{ can: () => boolean }` | you decide |
| `{ componentId: 'sales.export' }` | calls the `hasComponent(id)` hook passed to `configure()` |
| `{ roles: ['REPORT_EXPORTER'] }` | compares with the `getRoles()` hook passed to `configure()` |

Omitted = visible to everyone. If the matching hook is not configured the check is **fail-open**.

> This only **hides UI**. Real authorization happens in Report Studio, which authorizes every request
> from a verified token — a user who un-hides the button still cannot exceed their own rights.

## 5. Auth — reuse the app's session (edge auth)

The library **holds no token**. It sends `credentials:'include'`, so the edge session cookie
(oauth2-proxy at the gateway) rides along; the edge injects `X-Forwarded-Access-Token` (a verified
OIDC access token); Report Studio's `EdgeBearerAuthFilter` JWKS-verifies it, and **the report runs as
the real user** (`job.requestedBy`). No service account, no embedded passwords.

### Gateway setup

Expose a separate path `/reportstudio/edge-api/**` behind the edge, leaving `/reportstudio/api`
untouched. With oauth2-proxy, add an upstream pair (with and without trailing slash):

```
--upstream=http://reportstudio-api.<namespace>.svc.cluster.local:8080/reportstudio/edge-api
--upstream=http://reportstudio-api.<namespace>.svc.cluster.local:8080/reportstudio/edge-api/
```

**Why a separate path:** oauth2-proxy `--upstream` does not rewrite paths, and it has no per-route
"optional auth" (`--skip-auth-route` passes the request but **injects no token**). Fronting
`/reportstudio/api` directly would redirect the admin UI (which uses its own `rs.token`) to the IdP.

Report Studio accepts this path via `EdgeApiAliasConfig` (a Tomcat engine-level RewriteValve) that
rewrites `/reportstudio/edge-api/**` to the context path (`/reportstudio/api/**`). It is a **valve, not
a servlet Filter**, because Tomcat selects the Context from the URI before filters run — a path
outside the context path would 404 before reaching the app.

Point the library at it:

```js
RSExport.configure({ apiBase: '/reportstudio/edge-api' });
```

### Enabling it in Report Studio

Set the edge-auth properties documented in `backend/src/main/resources/application.yml`
(JWK set URI, issuer URI — must match the token's `iss` claim, accepted `azp`, and the role
granted to edge users, e.g. `USER` for run + read only). Unset = feature off, behavior unchanged.

The filter reads `X-Forwarded-Access-Token` first, then falls back to `Authorization: Bearer`;
verifies signature + issuer + expiry via JWKS, checks `azp`, and requires `sub`. It runs after the
existing filter, so the admin UI's `rs.token` always wins and the two never conflict.

### Apps not behind the edge

Supply a token yourself:

```js
RSExport.configure({ getToken: () => fetch('/my-app/api/reportstudio/token').then(r => r.json()).then(j => j.token) });
```

## 6. `RSExport.configure(...)`

| key | default | meaning |
|---|---|---|
| `apiBase` | `/reportstudio/api` | Report Studio API base |
| `credentials` | `'include'` | send the edge cookie |
| `getToken` | `null` | `() => token \| Promise<token>` (only when not behind the edge) |
| `pollMs` | `1500` | job status poll interval |
| `pollTimeoutMs` | `20 min` | matches the server-side render job cap |
| `historyLimit` | `15` | recent Jobs kept per browser |
| `hasComponent` | `null` | `(componentId) => boolean` — host page-permission check |
| `getRoles` | `null` | `() => string[]` — signed-in user's role codes |

Other API: `RSExport.open(opts)` · `RSExport.can(permission)` · `RSExport.history()` ·
`RSExport.download(jobId)` · `RSExport.version`

## 7. Integration notes

- **No dependencies** (no jQuery/Angular), so it works in template-based and SPA apps alike.
- **Never clobbers an existing global** — if `window.RSExport` exists it returns immediately (guards
  against double loading breaking the host script).
- Ships its own CSS (prefix `rsx-`).
- Uses the host's `alertModal()` / `Swal` when present, else `alert()`.
- Request bodies rejected by a WAF with 403 are retried automatically as base64
  (`X-Body-Encoding: base64`).
