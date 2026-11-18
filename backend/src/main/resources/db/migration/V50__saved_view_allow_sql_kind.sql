-- The Tables screen's SQL editor can "Save this SQL for later" and sends kind='sql'
-- (frontend/src/lib/api.ts declares "pivot" | "adhoc" | "sql"), but two guards only accepted pivot/adhoc:
--   1) AnalyticsController.saveView
--   2) this CHECK constraint — without fixing it too, saves pass the first guard and fail as a 500
-- so the feature never worked and the "Saved SQL scripts" panel (kind=sql) was always empty.
alter table saved_view drop constraint if exists saved_view_kind_check;
alter table saved_view add constraint saved_view_kind_check
    check (kind in ('pivot', 'adhoc', 'sql'));
