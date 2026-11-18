-- Resume from the failed step: a new run that points back to the original run and records which step
-- it started from.
--
-- It is always a new run, never an edit of the old row — the failed run's history (which steps passed,
-- which failed) must stay as it was, and the resumed run logs separately, in line with V40's intent that
-- every run be auditable. Steps before start_step_no are recorded as skipped with the reason
-- "passed in the previous run", not silently omitted.

ALTER TABLE etl_chain_run
    ADD COLUMN resumed_from_run_id BIGINT REFERENCES etl_chain_run(id),
    ADD COLUMN start_step_no       INT NOT NULL DEFAULT 1;
