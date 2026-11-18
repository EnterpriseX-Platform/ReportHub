-- A chain step can now be a saved SQL statement (the "scheduled SQL" building block), not only a
-- pipeline or a check.
--
-- A step may need to run more than a SELECT — e.g. PL/SQL or other statements that load data.
-- A pipeline is SELECT→table and a check is wrapped in SELECT COUNT(*); neither
-- can call a procedure or run a BEGIN…END block, so work that loads data that way had no way into
-- a chain. The scheduler row is already "a named statement against a datasource with run history",
-- so it becomes the third kind rather than a new concept.

ALTER TABLE etl_chain_step
    ADD COLUMN scheduler_id BIGINT REFERENCES scheduler(id) ON DELETE RESTRICT;

ALTER TABLE etl_chain_step DROP CONSTRAINT etl_chain_step_kind;
ALTER TABLE etl_chain_step ADD CONSTRAINT etl_chain_step_kind
    CHECK (kind IN ('pipeline', 'check', 'statement'));

ALTER TABLE etl_chain_step DROP CONSTRAINT etl_chain_step_ref;
ALTER TABLE etl_chain_step ADD CONSTRAINT etl_chain_step_ref CHECK (
    (kind = 'pipeline'  AND pipeline_id  IS NOT NULL AND check_id IS NULL     AND scheduler_id IS NULL) OR
    (kind = 'check'     AND check_id     IS NOT NULL AND pipeline_id IS NULL  AND scheduler_id IS NULL) OR
    (kind = 'statement' AND scheduler_id IS NOT NULL AND pipeline_id IS NULL  AND check_id IS NULL));

ALTER TABLE etl_chain_run_step
    ADD COLUMN scheduler_run_id BIGINT,
    ADD COLUMN affected         INT;

-- A scheduler that only ever runs as a chain step has no schedule of its own. cron was NOT NULL
-- because every scheduler used to be cron-driven; that is no longer true.
ALTER TABLE scheduler ALTER COLUMN cron DROP NOT NULL;
