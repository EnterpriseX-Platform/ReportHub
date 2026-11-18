-- How Replace empties the target before reloading.
--
-- clearTable() has always used DELETE, on purpose: it joins the surrounding transaction, so a
-- load that fails half-way leaves the old rows intact. That is the right default and stays the
-- default. It is also the wrong tool for large external-system extracts — ~200k rows of undo and
-- archive log per run, every run — so a pipeline may now opt into TRUNCATE.
--
-- TRUNCATE commits implicitly on Oracle: choosing it means accepting that a failure after the
-- clear leaves the target empty until the next successful run. The UI says so at the checkbox.

ALTER TABLE warehouse_pipeline
    ADD COLUMN clear_mode VARCHAR(16) NOT NULL DEFAULT 'delete';

COMMENT ON COLUMN warehouse_pipeline.clear_mode IS
  'How Replace empties the target: delete (transactional, default) | truncate (fast, commits, not rollback-safe)';
