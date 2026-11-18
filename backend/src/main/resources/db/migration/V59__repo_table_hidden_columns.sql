-- Columns that exist in the table but should not be shown on screen.
--
-- Unlike column_order (which says "in what order"), this says "show or hide".
-- Stored as a comma-separated list; null/empty = show every column as before.
--
-- Hiding affects display only — the data stays in the database, and key columns
-- (key_columns) are still read to identify rows on edit/delete; they just are not shown.
ALTER TABLE repo_table ADD COLUMN IF NOT EXISTS hidden_columns text;

-- Demo export table: hide audit/system columns that are not part of the export spec.
UPDATE repo_table
   SET hidden_columns = 'CREATED_DATE,UPDATED_DATE,UPDATED_BY,CREATED_BY,BATCH_JOB_ID,ROW_NO',
       updated_at = now()
 WHERE table_name = 'SALES_EXPORT' AND is_active AND hidden_columns IS NULL;
