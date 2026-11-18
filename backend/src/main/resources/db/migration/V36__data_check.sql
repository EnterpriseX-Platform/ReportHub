-- Data checks: run programs that validate report data.
--
-- A check is a SELECT that returns the rows that are WRONG. Zero rows = pass. That inversion is
-- the whole design: the author writes the thing they never want to see, and the screen can then
-- say pass/fail without knowing anything about the business rule, and show the offending rows
-- straight from the same query when it fails.
--
-- max_rows exists because some rules are "no more than N", not "never" — a check that is allowed
-- 20 known-bad legacy rows should stay green at 20 and go red at 21, rather than being switched
-- off and forgotten.
--
-- Shares the fiscal-year placeholders ($YEAR4/$YEAR2) and the folder convention with the warehouse
-- pipelines, so one check definition serves every year.

CREATE TABLE data_check (
    id            BIGSERIAL    PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    description   VARCHAR(512),
    folder        VARCHAR(255),
    datasource_id VARCHAR(32)  REFERENCES datasource(id),   -- NULL = internal warehouse
    sql_text      TEXT         NOT NULL,                    -- SELECT returning offending rows
    fiscal_year   VARCHAR(4),
    max_rows      INTEGER      NOT NULL DEFAULT 0,          -- fail when count > this
    enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
    cron          VARCHAR(120),                             -- NULL = manual only
    next_run_at   TIMESTAMPTZ,
    last_run_at   TIMESTAMPTZ,
    last_status   VARCHAR(16),                              -- pass | fail | error | running
    last_count    INTEGER,
    last_error    TEXT,
    created_by    VARCHAR(64),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE data_check_run (
    id          BIGSERIAL    PRIMARY KEY,
    check_id    BIGINT       NOT NULL REFERENCES data_check(id) ON DELETE CASCADE,
    started_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    status      VARCHAR(16)  NOT NULL,                      -- pass | fail | error
    trigger     VARCHAR(16)  NOT NULL,                      -- scheduled | manual
    row_count   INTEGER,
    message     TEXT,
    run_by      VARCHAR(64)
);

CREATE INDEX data_check_run_check_idx ON data_check_run (check_id, started_at DESC);
CREATE INDEX data_check_due_idx ON data_check (enabled, next_run_at);
