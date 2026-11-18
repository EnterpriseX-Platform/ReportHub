-- Column header names used when exporting a file, for when they differ from the real column names.
--
-- Format: COLUMN=Label, comma-separated · null/empty = use the real column name.
--
-- Example: a downstream file spec names a field YR while the table column is YEAR,
-- so the exported file must use the header YR. The screen still shows the real
-- column names so people working on the table are not confused.
ALTER TABLE repo_table ADD COLUMN IF NOT EXISTS column_labels text;
