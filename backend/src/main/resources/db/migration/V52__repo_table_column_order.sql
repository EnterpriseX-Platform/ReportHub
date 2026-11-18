-- Column order as displayed on screen; the physical order in the database is left untouched.
--
-- Why not reorder the table itself: Oracle cannot reorder columns in place; the table would have to
-- be rebuilt and the data copied, which for a large table (millions of rows) risks losing
-- partitioning, covering indexes and grants, and needs twice the free disk space during the copy.
--
-- Value format: groups separated by ';', each group is  COL[,COL...]>AFTER_COL
--   'TAX,TOTAL>PRICE; REGION_CODE,REGION_NAME>BRANCH_NAME'
-- meaning "move the left-hand columns to follow AFTER_COL"; columns not mentioned keep their order.
-- Names not found in the table are skipped silently (a changed table structure must not break the screen).
alter table repo_table add column if not exists column_order varchar(2000);

comment on column repo_table.column_order is
  'Display column order, format COL[,COL]>AFTER_COL, groups separated by ; - empty = physical database order';
