-- A chain step can now carry its own program instead of only pointing at a saved pipeline/check/
-- statement, written as reusable library-style code.
--
-- Shape borrowed from the Integration Platform, which does this well: a registry of step types,
-- each with its own executor and its own config, so adding a capability is adding one class rather
-- than touching the runner. `config` is that per-type config, as JSON — same choice the flow nodes
-- there make (TEXT holding JSON, read by the executor that owns the type).
--
-- The reference kinds stay exactly as they were: pointing at a saved pipeline is still the right
-- thing when several chains share one. Inline is for the step that exists only inside this chain.

ALTER TABLE etl_chain_step
    ADD COLUMN config TEXT,
    ADD COLUMN label  VARCHAR(255),
    -- Result of this step is published under this name, so a later step can read it with
    -- {{name.field}} — same idea as Integration's varName.
    ADD COLUMN var_name VARCHAR(64);

-- Inline kinds carry no reference id at all, so the old "exactly one id, matching kind" rule can no
-- longer be a blanket CHECK. Referential kinds keep it; inline kinds must carry config instead.
ALTER TABLE etl_chain_step DROP CONSTRAINT etl_chain_step_kind;
ALTER TABLE etl_chain_step DROP CONSTRAINT etl_chain_step_ref;

ALTER TABLE etl_chain_step ADD CONSTRAINT etl_chain_step_ref CHECK (
    (kind = 'pipeline'  AND pipeline_id  IS NOT NULL AND check_id IS NULL    AND scheduler_id IS NULL) OR
    (kind = 'check'     AND check_id     IS NOT NULL AND pipeline_id IS NULL AND scheduler_id IS NULL) OR
    (kind = 'statement' AND scheduler_id IS NOT NULL AND pipeline_id IS NULL AND check_id IS NULL)     OR
    (kind NOT IN ('pipeline', 'check', 'statement')
        AND pipeline_id IS NULL AND check_id IS NULL AND scheduler_id IS NULL
        AND config IS NOT NULL));

-- Which type names are valid is the executor registry's business, not the database's: a new step
-- type ships as a new class, and a CHECK listing them here would mean a migration every time.
