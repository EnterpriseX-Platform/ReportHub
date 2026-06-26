-- The render-unit SET is now THE report definition: every report gets a default unit
-- (same engine as before, format follows the job), so the worker always runs the units
-- path and the Config screen edits units instead of a report-level engine.
INSERT INTO report_unit (report_code, name, engine, fmt, sort_order, enabled, created_at)
SELECT r.code, 'default', r.engine, NULL, 1, true, now()
FROM report r
WHERE NOT EXISTS (SELECT 1 FROM report_unit u WHERE u.report_code = r.code);
