#!/usr/bin/env bash
# Rotate Report Studio's OWN secrets and (optionally) restrict CORS.
#
# Generates strong random JWT_SECRET / DB_PASSWORD / MINIO_SECRET_KEY, patches the
# `reportstudio-secret` Secret, and rolls the dependent workloads so the new values take effect.
# The new values are printed once and saved to a gitignored file — copy them into your vault, then
# delete that file. Nothing secret is ever written to Git.
#
# Usage:
#   export KUBECONFIG=/path/to/your-cluster.kubeconfig      # your OWN (rotated) kubeconfig
#   ./rotate-secrets.sh [--cors "https://host/reportstudio,https://host2"] [--namespace reportstudio]
#
# Storage note: the bundled Postgres/MinIO use emptyDir (SIT), so this RECREATES those pods and they
# re-init with the new credentials — ephemeral data is lost (Flyway reseeds; rendered outputs are
# ephemeral anyway). For PVC-backed PRODUCTION do NOT recreate the data pods; instead rotate in place:
#   • Postgres:  kubectl exec <pg-pod> -- psql -U <user> -c "ALTER ROLE <user> WITH PASSWORD '<new>';"
#   • MinIO:     mc admin user ... / update root creds, then restart only the api.
# Then patch the Secret (JWT_SECRET/DB_PASSWORD/MINIO_SECRET_KEY) and `rollout restart` the api.
set -euo pipefail

NS=reportstudio
CORS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cors)      CORS="${2:?--cors needs a value}"; shift 2 ;;
    --namespace) NS="${2:?--namespace needs a value}"; shift 2 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v kubectl >/dev/null || { echo "kubectl not found in PATH" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl not found in PATH" >&2; exit 1; }

# url-safe-ish alphanumeric of length $2 from $1 random bytes
gen() { openssl rand -base64 "${1:-48}" | tr -dc 'A-Za-z0-9' | cut -c1-"${2:-32}"; }

JWT_SECRET="$(gen 64 48)"          # ≥ 32 bytes for HS256
DB_PASSWORD="$(gen 48 28)"
MINIO_SECRET_KEY="$(gen 48 32)"

echo "→ patching reportstudio-secret in namespace '$NS'…"
PATCH="{\"stringData\":{\"JWT_SECRET\":\"$JWT_SECRET\",\"DB_PASSWORD\":\"$DB_PASSWORD\",\"MINIO_SECRET_KEY\":\"$MINIO_SECRET_KEY\""
[ -n "$CORS" ] && PATCH="$PATCH,\"CORS_ORIGINS\":\"$CORS\""
PATCH="$PATCH}}"
kubectl -n "$NS" patch secret reportstudio-secret -p "$PATCH"

echo "→ recreating data pods (emptyDir → re-init with new creds)…"
kubectl -n "$NS" rollout restart deploy/reportstudio-postgres deploy/reportstudio-minio
kubectl -n "$NS" rollout status  deploy/reportstudio-postgres --timeout=3m
kubectl -n "$NS" rollout status  deploy/reportstudio-minio    --timeout=3m

echo "→ restarting api to pick up new secret…"
kubectl -n "$NS" rollout restart deploy/reportstudio-api
kubectl -n "$NS" rollout status  deploy/reportstudio-api --timeout=6m

OUT="$(cd "$(dirname "$0")" && pwd)/.secrets.generated.env"
umask 077
{
  echo "# Report Studio rotated secrets — store in a vault, then DELETE this file. DO NOT COMMIT."
  echo "JWT_SECRET=$JWT_SECRET"
  echo "DB_PASSWORD=$DB_PASSWORD"
  echo "MINIO_SECRET_KEY=$MINIO_SECRET_KEY"
  [ -n "$CORS" ] && echo "CORS_ORIGINS=$CORS"
} > "$OUT"
chmod 600 "$OUT"

echo
echo "✔ Rotation complete. New values saved (mode 600) to: $OUT"
echo "  Copy them into your secret manager, then: rm -f \"$OUT\""
[ -n "$CORS" ] && echo "  CORS_ORIGINS now restricted to: $CORS"
