-- ETL chains: run several existing building blocks (warehouse pipelines, data checks) in a fixed
-- order as one unit, and keep a per-round history of every run.
--
-- This is deliberately a GENERIC feature: any concrete flow (load -> run checks -> transform -> export)
-- lives entirely in rows the user composes, not in code. The app knows only "chains of steps".
--
-- A run carries the fiscal year it was executed for and a round number unique within
-- (chain, year) — that is what lets several rounds per year be told apart: the
-- history is the rounds. Step results snapshot the referenced name and link to the underlying
-- warehouse_run / data_check_run rows, so a round stays readable even after a pipeline is renamed.

CREATE TABLE etl_chain (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    description VARCHAR(512),
    folder      VARCHAR(255),
    enabled     BOOLEAN     NOT NULL DEFAULT true,
    created_by  VARCHAR(64),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one of pipeline_id / check_id per step, matching kind. ON DELETE CASCADE would silently
-- shorten a chain when a pipeline is deleted — RESTRICT instead, so deleting a building block that
-- a chain still uses is refused and the user hears about it.
CREATE TABLE etl_chain_step (
    id          BIGSERIAL PRIMARY KEY,
    chain_id    BIGINT      NOT NULL REFERENCES etl_chain(id) ON DELETE CASCADE,
    step_no     INT         NOT NULL,
    kind        VARCHAR(16) NOT NULL,
    pipeline_id BIGINT      REFERENCES warehouse_pipeline(id) ON DELETE RESTRICT,
    check_id    BIGINT      REFERENCES data_check(id)         ON DELETE RESTRICT,
    on_fail     VARCHAR(16) NOT NULL DEFAULT 'stop',
    CONSTRAINT etl_chain_step_kind CHECK (kind IN ('pipeline', 'check')),
    CONSTRAINT etl_chain_step_on_fail CHECK (on_fail IN ('stop', 'continue')),
    CONSTRAINT etl_chain_step_ref CHECK (
        (kind = 'pipeline' AND pipeline_id IS NOT NULL AND check_id IS NULL) OR
        (kind = 'check'    AND check_id    IS NOT NULL AND pipeline_id IS NULL)),
    CONSTRAINT etl_chain_step_order UNIQUE (chain_id, step_no)
);

CREATE TABLE etl_chain_run (
    id          BIGSERIAL PRIMARY KEY,
    chain_id    BIGINT      NOT NULL REFERENCES etl_chain(id) ON DELETE CASCADE,
    fiscal_year VARCHAR(4),
    round_no    INT         NOT NULL,
    status      VARCHAR(16) NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    run_by      VARCHAR(64),
    message     TEXT,
    CONSTRAINT etl_chain_run_status CHECK (status IN ('running', 'success', 'failed', 'partial')),
    -- Round numbers are handed out under this constraint: MAX+1 inside the insert's transaction,
    -- and a collision from two simultaneous starts fails one of them loudly instead of minting
    -- two rounds with the same number.
    CONSTRAINT etl_chain_run_round UNIQUE (chain_id, fiscal_year, round_no)
);

CREATE INDEX idx_etl_chain_run_list ON etl_chain_run (chain_id, started_at DESC);

CREATE TABLE etl_chain_run_step (
    id                BIGSERIAL PRIMARY KEY,
    run_id            BIGINT      NOT NULL REFERENCES etl_chain_run(id) ON DELETE CASCADE,
    step_no           INT         NOT NULL,
    kind              VARCHAR(16) NOT NULL,
    ref_name          VARCHAR(255),
    status            VARCHAR(16) NOT NULL,
    rows_read         INT,
    rows_written      INT,
    check_count       INT,
    check_pass        BOOLEAN,
    warehouse_run_id  BIGINT,
    data_check_run_id BIGINT,
    message           TEXT,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at       TIMESTAMPTZ,
    CONSTRAINT etl_chain_run_step_status CHECK (status IN ('running', 'success', 'failed', 'skipped'))
);

CREATE INDEX idx_etl_chain_run_step ON etl_chain_run_step (run_id, step_no);
