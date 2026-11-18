-- Documentation-only migration (no schema change).
--
-- filter_columns format: COLUMN:label:name source:options source:default  (columns separated by ,)
--   options source empty = distinct values from the table itself (fine for small tables)
--   options source = SCHEMA.TABLE.CODE.NAME (for large tables where DISTINCT is too slow)
--   suffix @PARENT_COLUMN=FIELD = narrow the list by a parent picker
-- Defaults should use year placeholders ($YEAR4 = four digits, $YEAR2 = two digits) rather than
-- literal years, so screens roll over to the new fiscal year automatically.
SELECT 1;
