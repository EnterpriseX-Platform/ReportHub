#!/bin/bash
# Check the render queue is empty before deploying. Deploying over a running render kills it
# ("Worker restarted while this job was rendering").
# Usage: NS=<namespace> ./queue-check.sh   (uses the current kubeconfig)
NS="${NS:-reportstudio}"
POD=$(kubectl -n "$NS" get pod -l app=reportstudio-postgres -o jsonpath='{.items[0].metadata.name}')
K="kubectl -n $NS exec -i $POD -- psql -U reportstudio -d reportstudio -At"
BUSY=$(echo "select count(*) from job where state in ('running','queued');" | eval $K | tr -d ' ')
echo "Jobs in queue: ${BUSY:-?}"
if [ "${BUSY:-1}" != "0" ]; then
  echo "select '  J-'||id||'  '||state||'  '||coalesce(report_code,'?')||'  '||coalesce(to_char(started_at,'HH24:MI:SS'),'-') from job where state in ('running','queued') order by id;" | eval $K
  echo "Jobs still pending - do not deploy yet"; exit 1
fi
echo "Queue empty - safe to deploy"
