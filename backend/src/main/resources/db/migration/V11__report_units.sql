-- Render units: ONE report = MANY render units, executed together in a single run call.
-- Each unit picks its own engine (jasper / component / http / ...), its own output format,
-- and carries its own template files — a main template plus, for Jasper, subreports.
-- The worker renders every enabled unit in order and stores one artifact per unit,
-- so one call can emit several files and mix several engines.

CREATE TABLE report_unit (
    id          BIGSERIAL    PRIMARY KEY,
    report_code VARCHAR(64)  NOT NULL REFERENCES report(code) ON DELETE CASCADE,
    name        VARCHAR(128) NOT NULL,
    engine      VARCHAR(32)  NOT NULL DEFAULT 'jasper',
    fmt         VARCHAR(8),                          -- output format override (NULL = job format)
    config_json TEXT,                                -- engine-specific options for THIS unit
    sort_order  INTEGER      NOT NULL DEFAULT 0,
    enabled     BOOLEAN      NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_report_unit_code ON report_unit(report_code);

CREATE TABLE report_unit_file (
    id          BIGSERIAL    PRIMARY KEY,
    unit_id     BIGINT       NOT NULL REFERENCES report_unit(id) ON DELETE CASCADE,
    role        VARCHAR(16)  NOT NULL DEFAULT 'main'
                CHECK (role IN ('main','subreport','resource')),
    file_name   VARCHAR(255) NOT NULL,
    object_key  VARCHAR(512) NOT NULL,
    size_bytes  BIGINT       NOT NULL DEFAULT 0,
    uploaded_by VARCHAR(64),
    uploaded_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_report_unit_file_unit ON report_unit_file(unit_id);
