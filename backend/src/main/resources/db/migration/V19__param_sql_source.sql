-- Parameter options can now come from a guarded SQL query, optionally against any
-- registered JDBC datasource (default: internal warehouse). The table-driven mode
-- stays; its allowlist becomes dynamic (information_schema minus a denylist).
ALTER TABLE param_def DROP CONSTRAINT IF EXISTS param_def_source_type_check;
ALTER TABLE param_def ADD CONSTRAINT param_def_source_type_check
    CHECK (source_type IN ('static','query','sql'));
ALTER TABLE param_def ADD COLUMN source_sql    TEXT;
ALTER TABLE param_def ADD COLUMN datasource_id VARCHAR(64);
