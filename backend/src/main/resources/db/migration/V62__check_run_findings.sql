-- Store the failing rows with each check run.
--
-- Previously a run stored only the failing row count, so the Findings view re-ran every failing
-- query each time and the failing rows of older runs could not be reviewed.
--
-- Stored with a row cap (see the checks.finding-rows setting), not in full: a single check can
-- fail on hundreds of thousands of rows, which would bloat the database quickly.
ALTER TABLE data_check_run ADD COLUMN IF NOT EXISTS findings TEXT;
COMMENT ON COLUMN data_check_run.findings IS
  'Failing rows of this run (JSON {columns, rows}), capped; NULL = older run before this column, or a passing check';
