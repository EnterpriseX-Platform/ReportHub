-- Which columns identify a row, for tables that carry no primary key.
--
-- SALES_EXPORT has none, so the data screen fell back to read-only and the requirement that every
-- column be editable and savable could not be met. The rows/update/delete endpoints never
-- needed a declared PK -- they take whatever key columns they are handed and bind them -- so the
-- screen only needed to be told what to use.
--
-- Comma-separated column names. Left NULL, the screen keeps using the real primary key.
-- ROW_NO is unique and NOT NULL across every row of SALES_EXPORT, which is why it is safe as the
-- identifier here.
ALTER TABLE repo_table ADD COLUMN key_columns VARCHAR(500);

COMMENT ON COLUMN repo_table.key_columns IS
  'CSV of columns identifying a row when the table has no primary key; NULL = use the real PK';

UPDATE repo_table SET key_columns = 'ROW_NO'
 WHERE table_name = 'SALES_EXPORT' AND key_columns IS NULL;
