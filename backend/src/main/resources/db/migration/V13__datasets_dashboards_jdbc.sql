-- Real JDBC connections on datasources (PostgreSQL/Oracle), per-unit datasource,
-- user-defined datasets (SQL query editor), and BI dashboards with public share tokens.

ALTER TABLE datasource ADD COLUMN jdbc_url    VARCHAR(512);
ALTER TABLE datasource ADD COLUMN db_user     VARCHAR(128);
ALTER TABLE datasource ADD COLUMN db_password VARCHAR(256);

ALTER TABLE report_unit ADD COLUMN datasource_id VARCHAR(32);

CREATE TABLE dataset_def (
    id            BIGSERIAL    PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    description   VARCHAR(512),
    datasource_id VARCHAR(32)  REFERENCES datasource(id),
    sql_text      TEXT         NOT NULL,
    created_by    VARCHAR(64),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE dashboard (
    id          BIGSERIAL    PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    layout_json TEXT         NOT NULL,            -- widgets: [{title, viz, source...}]
    params_json TEXT,                             -- global params, e.g. {"fiscalYear":"2026"}
    share_token VARCHAR(64)  UNIQUE,              -- non-null = publicly viewable
    created_by  VARCHAR(64),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
