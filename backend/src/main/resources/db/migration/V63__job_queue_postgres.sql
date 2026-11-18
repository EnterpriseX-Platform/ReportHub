-- The job table is now the render queue itself (replaces the former external message broker).
--
-- Enqueue  = a row committed with state 'queued'.
-- Claim    = a worker flips it to 'running' with
--            UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n),
--            so concurrent workers never take the same job.
-- Liveness = the owning worker bumps heartbeat_at while the job renders; a running job whose
--            heartbeat goes stale was left behind by a dead worker and is failed by the sweeper.

-- Everything the worker needs to render (the former message envelope), as JSON.
ALTER TABLE job ADD COLUMN payload      TEXT;
-- Short-lived caller access token for edge-authenticated runs. Kept apart from payload so it is
-- cleared atomically when the job is claimed (and never survives the queue).
ALTER TABLE job ADD COLUMN caller_token TEXT;
ALTER TABLE job ADD COLUMN claimed_by   VARCHAR(128);
ALTER TABLE job ADD COLUMN claimed_at   TIMESTAMPTZ;
ALTER TABLE job ADD COLUMN heartbeat_at TIMESTAMPTZ;

-- The claim query only ever looks at queued rows; keep that scan tiny as the table grows.
CREATE INDEX idx_job_queued ON job (started_at) WHERE state = 'queued';
-- The orphan sweeper only looks at running rows.
CREATE INDEX idx_job_running_heartbeat ON job (heartbeat_at) WHERE state = 'running';
