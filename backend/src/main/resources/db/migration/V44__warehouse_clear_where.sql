-- Scoped Replace: empty only the slice of the target this pipeline owns, then load.
--
-- A target table may hold several slices (e.g. years or categories) in ONE table.
-- Reloading one slice had no safe mode:
--   replace  wipes the whole table, taking the other slices with it
--   upsert   deletes row-by-row — very slow on large slices
--   append   inserts blindly, so a second click silently doubles the slice
-- clear_where closes that gap: DELETE ... WHERE <predicate> once, then a plain bulk insert.
alter table warehouse_pipeline add column clear_where text;

comment on column warehouse_pipeline.clear_where is
  'Replace mode only: rows matching this predicate are deleted before the load instead of the whole table. $YEAR4/$YEAR2 are substituted the same way source_sql does it. NULL = clear everything (previous behaviour).';
