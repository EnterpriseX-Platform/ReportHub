-- Data Warehouse pipelines: pull rows from a source datasource (a SELECT with conditions) and load
-- them into a target table on any datasource, with Replace / Append / Upsert-by-key, optional cron.

CREATE TABLE warehouse_pipeline (
    id                   BIGSERIAL    PRIMARY KEY,
    name                 VARCHAR(255) NOT NULL,
    description          VARCHAR(512),
    source_datasource_id VARCHAR(32)  REFERENCES datasource(id),  -- NULL = internal warehouse
    source_sql           TEXT         NOT NULL,                   -- a single SELECT (conditions in WHERE)
    target_datasource_id VARCHAR(32)  REFERENCES datasource(id),  -- NULL = internal warehouse
    target_table         VARCHAR(128) NOT NULL,
    load_mode            VARCHAR(16)  NOT NULL DEFAULT 'replace',  -- replace | append | upsert
    key_columns          VARCHAR(512),                            -- csv, required for upsert
    auto_create          BOOLEAN      NOT NULL DEFAULT TRUE,       -- create target from result schema if missing
    cron                 VARCHAR(120),                            -- NULL = manual only
    enabled              BOOLEAN      NOT NULL DEFAULT TRUE,
    next_run_at          TIMESTAMPTZ,
    last_run_at          TIMESTAMPTZ,
    last_status          VARCHAR(16),                             -- ok | error | running
    last_error           TEXT,
    last_rows_read       INTEGER,
    last_rows_written    INTEGER,
    created_by           VARCHAR(64),
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_run (
    id           BIGSERIAL    PRIMARY KEY,
    pipeline_id  BIGINT       NOT NULL REFERENCES warehouse_pipeline(id) ON DELETE CASCADE,
    started_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    status       VARCHAR(16)  NOT NULL,                           -- ok | error
    trigger      VARCHAR(16)  NOT NULL,                           -- scheduled | manual
    rows_read    INTEGER,
    rows_written INTEGER,
    message      TEXT,
    run_by       VARCHAR(64)
);

CREATE INDEX idx_warehouse_run_pipe ON warehouse_run (pipeline_id, started_at DESC);
CREATE INDEX idx_warehouse_due ON warehouse_pipeline (enabled, next_run_at);
