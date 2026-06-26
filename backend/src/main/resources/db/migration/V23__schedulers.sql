-- scheduled SQL jobs ("Schedulers") — run an INSERT/UPDATE/DELETE/MERGE against a
-- configured datasource on a cron schedule, with enable/disable, manual run, and run history.

CREATE TABLE scheduler (
    id            BIGSERIAL    PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    description   VARCHAR(512),
    datasource_id VARCHAR(32)  REFERENCES datasource(id),  -- NULL = internal warehouse
    sql_text      TEXT         NOT NULL,                   -- single INSERT/UPDATE/DELETE/MERGE
    cron          VARCHAR(120) NOT NULL,                   -- Spring 6-field cron (sec min hour dom mon dow)
    enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
    next_run_at   TIMESTAMPTZ,                             -- when the dispatcher should next fire it
    last_run_at   TIMESTAMPTZ,
    last_status   VARCHAR(16),                             -- ok | error | running
    last_error    TEXT,
    last_affected INTEGER,
    created_by    VARCHAR(64),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE scheduler_run (
    id           BIGSERIAL    PRIMARY KEY,
    scheduler_id BIGINT       NOT NULL REFERENCES scheduler(id) ON DELETE CASCADE,
    started_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    status       VARCHAR(16)  NOT NULL,                    -- ok | error
    trigger      VARCHAR(16)  NOT NULL,                    -- scheduled | manual
    affected     INTEGER,
    message      TEXT,
    run_by       VARCHAR(64)
);

CREATE INDEX idx_scheduler_run_sched ON scheduler_run (scheduler_id, started_at DESC);
CREATE INDEX idx_scheduler_due ON scheduler (enabled, next_run_at);
