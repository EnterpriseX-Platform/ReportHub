# Deploy Report Studio (Kubernetes)

Manifests to run Report Studio on a Kubernetes cluster, served under the **`/reportstudio`** basename.
Replace every `<placeholder>` (cluster API, node IP, registry, NFS server, hostnames) with your own values.

## Components

| Component | How |
|---|---|
| `reportstudio-api` | Spring Boot, image `<registry>/reportstudio-api`, ClusterIP :8080, context-path `/reportstudio/api` |
| `reportstudio-app` | Next.js, image `<registry>/reportstudio-app`, ClusterIP :3000, basePath `/reportstudio` |
| `reportstudio-proxy` | edge nginx (`45-proxy.yaml`), NodePort, fronts app + api on one same-origin entry point |
| **Postgres** | dedicated `reportstudio-postgres` (emptyDir by default — Flyway reseeds on restart; use a PVC for persistence) |
| **MinIO** | dedicated `reportstudio-minio` (emptyDir by default — use a PVC for persistence) |
| **Kafka** | dedicated `reportstudio-kafka` (KRaft single-node) for the async render gateway |
| **Component engine** | optional remote OneWeb "component" engine — configure its URL + token in the UI (see below) |

### Why the edge proxy

`45-proxy.yaml` is a tiny nginx that fronts `/reportstudio` → app and `/reportstudio/api` → api on its own
NodePort, giving a single same-origin entry point. Use it when the cluster ingress controller does not serve
host-less rules, or front the two Services with your own ingress / reverse proxy instead. `50-ingress.yaml`
is kept for when a real `/reportstudio` host is assigned.

If you front the app with Apache, the proxy entries are (API before app — first-prefix-wins):

```apache
  ProxyPass        /reportstudio/api http://<reportstudio-api-svc>:8080/reportstudio/api
  ProxyPassReverse /reportstudio/api http://<reportstudio-api-svc>:8080/reportstudio/api
  ProxyPass        /reportstudio     http://<reportstudio-app-svc>:3000/reportstudio
  ProxyPassReverse /reportstudio     http://<reportstudio-app-svc>:3000/reportstudio
```

## Build + push the images

```bash
REGISTRY="<your-registry>"            # e.g. your Docker Hub namespace or private registry
TAG="v1.$(date +%Y%m%d.%H%M)"

# API (context = backend/)
docker build --platform=linux/amd64 -t $REGISTRY/reportstudio-api:$TAG backend/
docker push  $REGISTRY/reportstudio-api:$TAG

# WEB — basename + API base are baked at build time. API base is RELATIVE → same-origin on any host/IP.
docker build --platform=linux/amd64 \
  --build-arg NEXT_BASE_PATH=/reportstudio \
  --build-arg NEXT_PUBLIC_API_BASE=/reportstudio/api \
  -t $REGISTRY/reportstudio-app:$TAG frontend/
docker push  $REGISTRY/reportstudio-app:$TAG
```

## Apply

```bash
export KUBECONFIG=<your-kubeconfig>
NS=<your-namespace>

# 1) storage + secret + workloads + proxy + ingress (committed YAML uses :placeholder image tags)
kubectl -n $NS apply -f k8s/

# 2) set real secret values (see "Secrets" below) — never commit real values
cd k8s && ./rotate-secrets.sh --namespace $NS && cd ..

# 3) point the deployments at the freshly-pushed tag
kubectl -n $NS set image deploy/reportstudio-api reportstudio-api=$REGISTRY/reportstudio-api:$TAG
kubectl -n $NS set image deploy/reportstudio-app reportstudio-app=$REGISTRY/reportstudio-app:$TAG

# 4) wait + verify
kubectl -n $NS rollout status deploy/reportstudio-api --timeout=6m
kubectl -n $NS rollout status deploy/reportstudio-app --timeout=6m
kubectl -n $NS get pods | grep reportstudio
```

Smoke test (via the NodePort proxy — substitute a node IP and the assigned NodePort):
```bash
curl -s http://<node-ip>:<nodePort>/reportstudio/api/actuator/health      # {"status":"UP"}
# then open http://<node-ip>:<nodePort>/reportstudio in a browser
```

## After it's up

- **Component engine** — UI → *Platform › Engines › Install engine* → Remote URL, kind `component`,
  base URL = the component service URL, auth token (entered in the UI, stored encrypted at rest),
  format `yml`. Then set a report's `engine = component` to render via the remote engine.
- **Login**: the seed migration creates `admin / admin` (ADMIN) and `analyst / analyst` (read/run).
  **Change these immediately**, seed real users, and rotate `JWT_SECRET` before any non-local use.

## Secrets

`10-secret.yaml` ships with **placeholders** (`__SET_BY_ROTATE_SCRIPT__`) — no real secret is in Git.
Set real values after `kubectl apply` with `./rotate-secrets.sh`, which generates strong
`JWT_SECRET` / `DB_PASSWORD` / `MINIO_SECRET_KEY` (and, once, an `ENCRYPTION_KEY`), patches the
`reportstudio-secret` Secret, and rolls the workloads. It writes the new values to a **gitignored**
`k8s/.secrets.generated.env` (mode 600) — copy them to your vault, then delete the file.

- `ENCRYPTION_KEY` (engine authToken AES key) is **preserved** across rotations on purpose: there is no
  re-encryption path, so a fresh key would orphan every saved token. Set it once and keep it.
- For PVC-backed production, rotate the data-store credentials **in place** (Postgres `ALTER ROLE … PASSWORD`,
  MinIO root creds) instead of recreating the data pods — see the header of `rotate-secrets.sh`.

## Notes

- **emptyDir storage is ephemeral.** Postgres data + rendered files reset if a pod restarts; Flyway re-seeds
  automatically. For persistence, bind a PVC to a static PV — see `05-persistent-volumes.yaml`.
- **Reuse a shared MinIO**: delete `01-storage-minio.yaml` and point `MINIO_ENDPOINT` +
  `MINIO_ACCESS_KEY/SECRET_KEY` in the Secret at your MinIO service.
- **CORS**: a same-origin POST still sends an `Origin` header, so CORS must allow it. `SecurityConfig` +
  `WebConfig` use `allowedOriginPatterns` with default `*` (safe here: Bearer-token auth, no cookies).
  Lock it down via `CORS_ORIGINS` once a fixed host is assigned: `./rotate-secrets.sh --cors "https://<host>/reportstudio"`.
- **Engine auth tokens are never hardcoded** — they are entered per engine in the UI and stored encrypted.
  Never paste live tokens into chat, code, or Git.
