-- Parameter catalog (table-driven dropdowns + dependencies), per-report flow config,
-- saved views, ad-hoc run history, and report config_json.

-- ---------- Reference lookups (example cascade: region -> branch) ----------
-- Tables are created empty; populate them (via the Datasets SQL editor, an import, or
-- your own migration) to drive the regionCode / branchCode dropdowns below.
CREATE TABLE ref_region (
    code    VARCHAR(8)   PRIMARY KEY,
    name VARCHAR(255) NOT NULL
);

CREATE TABLE ref_branch (
    code        VARCHAR(16)  PRIMARY KEY,
    name     VARCHAR(255) NOT NULL,
    region_code VARCHAR(8)   NOT NULL REFERENCES ref_region(code)
);
CREATE INDEX idx_ref_branch_region ON ref_branch(region_code);

-- ---------- Parameter catalog ----------
-- A parameter is either STATIC (options_json) or QUERY (lookup_table/value/label columns).
-- depends_on + filter_column make a parameter cascade off its parent's selected value.
CREATE TABLE param_def (
    id             BIGSERIAL    PRIMARY KEY,
    name           VARCHAR(64)  NOT NULL UNIQUE,            -- runtime key, e.g. regionCode
    label       VARCHAR(255) NOT NULL,
    type           VARCHAR(16)  NOT NULL DEFAULT 'string'
                   CHECK (type IN ('string','integer','boolean','enum','date')),
    required       BOOLEAN      NOT NULL DEFAULT false,
    default_value  VARCHAR(255),
    source_type    VARCHAR(8)   NOT NULL DEFAULT 'static'
                   CHECK (source_type IN ('static','query')),
    options_json   TEXT,                                    -- static: JSON [{value,label}]
    lookup_table   VARCHAR(64),                             -- query: whitelisted table
    value_column   VARCHAR(64),
    label_column   VARCHAR(64),
    depends_on     VARCHAR(64),                             -- parent param name
    filter_column  VARCHAR(64),                             -- column filtered by parent value
    sort_order     INTEGER      NOT NULL DEFAULT 0
);

-- Per-report parameter assignment (ordered).
CREATE TABLE report_param (
    report_code VARCHAR(64) NOT NULL REFERENCES report(code) ON DELETE CASCADE,
    param_name  VARCHAR(64) NOT NULL REFERENCES param_def(name) ON DELETE CASCADE,
    sort_order  INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (report_code, param_name)
);

-- A small set of common parameter definitions (config, not sample data).
INSERT INTO param_def (name, label, type, required, default_value, source_type, options_json,
                       lookup_table, value_column, label_column, depends_on, filter_column, sort_order) VALUES
  ('fiscalYear',  'Fiscal year', 'integer', true,  '2026', 'static',
   '[{"value":"2026","label":"2026"},{"value":"2025","label":"2025"},{"value":"2024","label":"2024"}]',
   NULL, NULL, NULL, NULL, NULL, 1),
  ('quarter',     'Quarter',      'enum',    true,  'FULL', 'static',
   '[{"value":"Q1","label":"Q1"},{"value":"Q2","label":"Q2"},{"value":"Q3","label":"Q3"},{"value":"Q4","label":"Q4"},{"value":"FULL","label":"Full year"}]',
   NULL, NULL, NULL, NULL, NULL, 2),
  ('regionCode',  'Region',       'enum',    true,  NULL,   'query', NULL,
   'ref_region', 'code', 'name', NULL, NULL, 3),
  ('branchCode',  'Branch',       'enum',    false, NULL,   'query', NULL,
   'ref_branch', 'code', 'name', 'regionCode', 'region_code', 4),
  ('channel',     'Channel',      'enum',    false, NULL,   'static',
   '[{"value":"online","label":"Online"},{"value":"instore","label":"In-store"},{"value":"wholesale","label":"Wholesale"},{"value":"dealer","label":"Dealer"}]',
   NULL, NULL, NULL, NULL, NULL, 5),
  ('includeSubtotals','Include subtotals','boolean', false, 'true', 'static', NULL, NULL, NULL, NULL, NULL, NULL, 6),
  ('lang',        'Language',     'enum',    false, 'th',   'static',
   '[{"value":"th","label":"Thai"},{"value":"en","label":"English"}]',
   NULL, NULL, NULL, NULL, NULL, 7),
  ('compareYear', 'Compare year', 'integer', false, '2025', 'static',
   '[{"value":"2025","label":"2025"},{"value":"2024","label":"2024"}]',
   NULL, NULL, NULL, NULL, NULL, 8);

-- (No per-report assignments seeded — assigned when reports are created.)

-- ---------- Per-report render flow (React Flow JSON) ----------
CREATE TABLE report_flow (
    report_code VARCHAR(64)  PRIMARY KEY REFERENCES report(code) ON DELETE CASCADE,
    flow_json   TEXT         NOT NULL,
    updated_by  VARCHAR(64),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------- Saved views (workbench pivots + ad-hoc queries) ----------
CREATE TABLE saved_view (
    id         BIGSERIAL    PRIMARY KEY,
    kind       VARCHAR(16)  NOT NULL CHECK (kind IN ('pivot','adhoc')),
    name       VARCHAR(255) NOT NULL,
    dataset    VARCHAR(64),
    payload    TEXT         NOT NULL,            -- the request JSON to replay
    created_by VARCHAR(64),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------- Ad-hoc run history (real, appended on every /adhoc/run) ----------
CREATE TABLE adhoc_run_log (
    id         BIGSERIAL    PRIMARY KEY,
    dataset    VARCHAR(64)  NOT NULL,
    fields     TEXT         NOT NULL,
    filters    TEXT,
    row_count  INTEGER      NOT NULL DEFAULT 0,
    created_by VARCHAR(64),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------- Structured engine config on the report itself ----------
ALTER TABLE report ADD COLUMN config_json TEXT;
