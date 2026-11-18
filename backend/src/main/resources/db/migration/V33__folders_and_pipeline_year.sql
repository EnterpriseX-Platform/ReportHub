-- Folders for the lists that did not have them, and the fiscal-year placeholders a warehouse
-- pipeline needs so one definition can load one year at a time.
--
-- folder mirrors saved_view.folder / dashboard.folder from V16: a '/'-separated path shown as a
-- tree, NULL = ungrouped. datasets, pipelines and the data-screen table registry all grew long
-- enough to need it; saved views and dashboards already had it.
--
-- $YEAR4 / $YEAR2 in source_sql are the same two placeholders repo_table.eq_filter already uses,
-- because source databases may store a year as four digits or only as its last two digits. One pipeline can then
-- serve every year instead of one pipeline per year.
--
-- fiscal_year is what a scheduled run substitutes, since a timer has no UI to read the year
-- from. A manual run may override it with the year chosen by the caller.

ALTER TABLE warehouse_pipeline ADD COLUMN folder      VARCHAR(255);
ALTER TABLE warehouse_pipeline ADD COLUMN fiscal_year VARCHAR(4);

ALTER TABLE dataset_def ADD COLUMN folder VARCHAR(255);
ALTER TABLE repo_table  ADD COLUMN folder VARCHAR(255);

COMMENT ON COLUMN warehouse_pipeline.folder IS
  'Folder path for the pipeline tree; NULL = ungrouped';
COMMENT ON COLUMN warehouse_pipeline.fiscal_year IS
  'Fiscal year substituted into $YEAR4/$YEAR2 in source_sql on a scheduled run; NULL = the caller must supply one';
COMMENT ON COLUMN dataset_def.folder IS
  'Folder path for the dataset tree; NULL = ungrouped';
COMMENT ON COLUMN repo_table.folder IS
  'Folder path grouping the tables offered by one data screen; NULL = ungrouped';
