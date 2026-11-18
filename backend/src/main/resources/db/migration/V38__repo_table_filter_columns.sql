-- Which columns a data screen offers as user-driven filters.
--
-- eq_filter is the fixed slice an admin pins to an entry (STATUS=active) — the user never sees or
-- changes it. This column is different: filters the person looking at the screen picks (e.g. by step,
-- region, branch). It is a CSV of column names the screen renders as pickers, on top of whatever
-- eq_filter already pins. High-cardinality columns use a searchable picker rather than a full list.

ALTER TABLE repo_table ADD COLUMN filter_columns VARCHAR(500);

COMMENT ON COLUMN repo_table.filter_columns IS
  'CSV of columns the screen offers as user-selectable filters; NULL = none. Distinct from eq_filter, which is a fixed admin-pinned slice.';
