-- A pipeline is an ordered list of "steps", not a single load.
--
-- Rationale: the system had two concepts for the same thing — warehouse_pipeline (one load)
-- and etl_chain (several things strung together). etl_chain was barely used while
-- warehouse_pipeline ran daily, so the two are merged by growing the one actually in use
-- rather than migrating users to the unused one (which would have meant moving every pipeline,
-- its run history and all FKs for no gain).

CREATE TABLE warehouse_pipeline_step (
    id           BIGSERIAL   PRIMARY KEY,
    pipeline_id  BIGINT      NOT NULL REFERENCES warehouse_pipeline(id) ON DELETE CASCADE,
    -- Execution order; gaps are allowed (insert a step without renumbering) but no duplicates within a pipeline.
    step_no      INT         NOT NULL,
    -- load = load data into a table · sql = a single statement · check = a saved check set · assert = an inline gate
    kind         VARCHAR(24) NOT NULL,
    label        VARCHAR(160),
    -- The step's own program; shape depends on kind (load uses the same fields as the original pipeline).
    config       TEXT,
    -- What to do when this step fails: stop = halt the whole pipeline (default — steps are ordered and later
    -- ones consume earlier results, so continuing past a broken step accumulates bad data) · continue = go on to the next step.
    on_fail      VARCHAR(16) NOT NULL DEFAULT 'stop',
    -- Variable name this step publishes its result under, referenced later as {{name}}.
    var_name     VARCHAR(64),
    CONSTRAINT warehouse_pipeline_step_kind    CHECK (kind IN ('load', 'sql', 'check', 'assert')),
    CONSTRAINT warehouse_pipeline_step_on_fail CHECK (on_fail IN ('stop', 'continue')),
    CONSTRAINT warehouse_pipeline_step_uq      UNIQUE (pipeline_id, step_no)
);
CREATE INDEX idx_warehouse_pipeline_step ON warehouse_pipeline_step (pipeline_id, step_no);

-- Per-step results of each run — existing runs stay in warehouse_run as before; no history conversion needed.
CREATE TABLE warehouse_run_step (
    id            BIGSERIAL   PRIMARY KEY,
    run_id        BIGINT      NOT NULL REFERENCES warehouse_run(id) ON DELETE CASCADE,
    step_no       INT         NOT NULL,
    kind          VARCHAR(24) NOT NULL,
    label         VARCHAR(160),
    status        VARCHAR(16) NOT NULL,
    rows_read     INTEGER,
    rows_written  INTEGER,
    affected      INTEGER,
    message       TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    CONSTRAINT warehouse_run_step_status CHECK (status IN ('running', 'success', 'failed', 'skipped', 'cancelled'))
);
CREATE INDEX idx_warehouse_run_step ON warehouse_run_step (run_id, step_no);

-- Existing pipelines become "single-step pipelines" without moving any data — the step's config is built
-- from the pipeline's own columns, every field the loader actually uses (the runner reads steps first and
-- falls back to the legacy columns when there are none — for pipelines created before this migration ran).
INSERT INTO warehouse_pipeline_step (pipeline_id, step_no, kind, label, config, on_fail)
SELECT p.id, 1, 'load', NULL,
       json_build_object(
           'sourceDatasourceId', p.source_datasource_id,
           'sourceSql',          p.source_sql,
           'targetDatasourceId', p.target_datasource_id,
           'targetSchema',       p.target_schema,
           'targetTable',        p.target_table,
           'loadMode',           p.load_mode,
           'clearMode',          p.clear_mode,
           'clearWhere',         p.clear_where,
           'keyColumns',         p.key_columns,
           'autoCreate',         p.auto_create,
           'addColumns',         p.add_columns,
           'controlColumn',      p.control_column,
           'controlTolerance',   p.control_tolerance
       )::text,
       'stop'
  FROM warehouse_pipeline p;
