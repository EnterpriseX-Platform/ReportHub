-- Which column of a registered table holds the year the screen's optional year picker filters on.
-- Explicit per table: the application never guesses a year column from column names.
-- NULL = the table has no year picker and exports are never cut by year.
ALTER TABLE repo_table ADD COLUMN IF NOT EXISTS year_column VARCHAR(128);

COMMENT ON COLUMN repo_table.year_column IS
  'Column holding the year for the optional year picker / export year filter; NULL = none';
