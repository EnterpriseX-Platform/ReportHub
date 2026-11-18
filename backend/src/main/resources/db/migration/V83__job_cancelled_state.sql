-- Jobs stopped by the user get their own terminal state instead of being lumped in with errors,
-- and the stage column records the actual engine (sql/api/jasper/...) during rendering.
ALTER TABLE job DROP CONSTRAINT IF EXISTS job_state_check;
ALTER TABLE job ADD CONSTRAINT job_state_check
    CHECK (state IN ('queued', 'running', 'done', 'error', 'cancelled'));
ALTER TABLE job DROP CONSTRAINT IF EXISTS job_stage_check;
ALTER TABLE job ALTER COLUMN stage TYPE VARCHAR(32);
UPDATE job SET state = 'cancelled' WHERE state = 'error' AND error_message LIKE 'Cancelled%';
