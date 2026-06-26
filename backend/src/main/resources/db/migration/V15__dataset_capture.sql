-- Dataset capture (snapshot): a dataset can materialize its source query into a local
-- warehouse table (ds_cap_<id>) so ad-hoc/dashboards read the snapshot instead of
-- hitting the source (e.g. a slow Oracle view) on every call.
ALTER TABLE dataset_def ADD COLUMN capture_mode VARCHAR(8) NOT NULL DEFAULT 'live';
ALTER TABLE dataset_def ADD COLUMN captured_at  TIMESTAMPTZ;
ALTER TABLE dataset_def ADD COLUMN capture_rows INTEGER;
ALTER TABLE dataset_def ADD COLUMN columns_json TEXT;
