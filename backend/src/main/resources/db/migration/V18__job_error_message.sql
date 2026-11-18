-- Store the actual render-failure reason so the Queue Monitor can surface it instead of
-- showing a hardcoded placeholder. Also removes the stage CHECK so future engine stages
-- (e.g. "component") never cause a constraint violation.
ALTER TABLE job ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE job DROP CONSTRAINT IF EXISTS job_stage_check;
