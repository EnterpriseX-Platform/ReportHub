-- Automatic reconciliation: after a load finishes, the pipeline compares target totals against
-- the source and stores the result with the run.
--
-- The pipeline already knows its own scope (clear_where) and its source query, so checking at the
-- end of the job is the cheapest point and the one where the data is still fresh.

ALTER TABLE warehouse_pipeline
    -- Control-total column in the output (e.g. TOTAL_AMOUNT). NULL = no check, existing behaviour unchanged.
    -- Note: values may be stored as text, so the comparison wraps them in TO_NUMBER itself.
    ADD COLUMN control_column    VARCHAR(128),
    -- Accepted difference in the total (same unit as the control column); row counts must always match exactly.
    ADD COLUMN control_tolerance NUMERIC(18, 2) NOT NULL DEFAULT 0;

ALTER TABLE warehouse_run
    ADD COLUMN src_rows      BIGINT,          -- counted from the source query (aggregate, no rows pulled back)
    ADD COLUMN tgt_rows      BIGINT,          -- counted from the target, limited to this pipeline's scope
    ADD COLUMN src_sum       NUMERIC(24, 4),
    ADD COLUMN tgt_sum       NUMERIC(24, 4),
    ADD COLUMN recon_status  VARCHAR(16),     -- match | mismatch | error; NULL = not checked
    ADD COLUMN recon_message TEXT;
