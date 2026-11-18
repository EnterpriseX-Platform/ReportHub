-- Full captured run log (cause chain + stack trace + up to ~1000 log lines) for a FAILED job,
-- so operators can download/copy it from the Queue Monitor instead of going into the cluster.
ALTER TABLE job ADD COLUMN IF NOT EXISTS error_detail TEXT;
