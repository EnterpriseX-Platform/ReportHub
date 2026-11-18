-- New run states: 'queued' (enqueued, not yet picked up by a worker) and 'cancelled' (stopped by the user).
--
-- Without 'queued', every step started together showed as running even though the worker runs
-- one at a time; and a long-running job could not be cancelled from the UI.
--
-- warehouse_run.status has no CHECK (V24 documents it in a comment); the chain tables have a strict
-- CHECK from V40, so drop it and recreate it including the two new states.

ALTER TABLE etl_chain_run DROP CONSTRAINT etl_chain_run_status;
ALTER TABLE etl_chain_run ADD CONSTRAINT etl_chain_run_status
    CHECK (status IN ('queued', 'running', 'success', 'failed', 'partial', 'cancelled'));

-- Steps have no 'queued' (the row is created when the step starts); 'cancelled' is added for future use.
-- A step interrupted mid-run is recorded as failed with a message; steps not yet reached are skipped.
ALTER TABLE etl_chain_run_step DROP CONSTRAINT etl_chain_run_step_status;
ALTER TABLE etl_chain_run_step ADD CONSTRAINT etl_chain_run_step_status
    CHECK (status IN ('running', 'success', 'failed', 'skipped', 'cancelled'));
