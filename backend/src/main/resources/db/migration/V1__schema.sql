-- Report Studio — registry schema
-- Business terms kept generic for traceability.

-- Report categories with required minimum counts
CREATE TABLE report_category (
    id          VARCHAR(16)  PRIMARY KEY,
    ref         VARCHAR(16)  NOT NULL,            -- category ref, e.g. C4
    name        VARCHAR(255) NOT NULL,
    min_reports INTEGER      NOT NULL,            -- required minimum (at least)
    sort_order  INTEGER      NOT NULL DEFAULT 0
);

-- Datasource connections (Oracle/PG/external system API/…) — dataset families map onto these
CREATE TABLE datasource (
    id          VARCHAR(32)  PRIMARY KEY,
    name        VARCHAR(128) NOT NULL,
    engine      VARCHAR(64)  NOT NULL,            -- Oracle 19c / PostgreSQL 15 / REST-SOAP / ...
    host        VARCHAR(255),
    schema_name VARCHAR(64),
    status      VARCHAR(16)  NOT NULL DEFAULT 'healthy'
                CHECK (status IN ('healthy','degraded','down')),
    latency_ms  INTEGER,
    pool        VARCHAR(32)
);

-- Report definitions — the core registry (≥265 across the report categories)
CREATE TABLE report (
    id            VARCHAR(32)  PRIMARY KEY,
    code          VARCHAR(64)  NOT NULL UNIQUE,   -- e.g. RPT-A-501
    name          VARCHAR(512) NOT NULL,
    category_id   VARCHAR(16)  NOT NULL REFERENCES report_category(id),
    engine        VARCHAR(16)  NOT NULL DEFAULT 'jasper'
                  CHECK (engine IN ('jasper','api','sql','composite')),
    formats       VARCHAR(64)  NOT NULL DEFAULT 'PDF',   -- CSV of PDF,XLSX,DOCX,CSV
    status        VARCHAR(16)  NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('active','testing','draft','error')),
    datasource_id VARCHAR(32)  REFERENCES datasource(id),
    template_path VARCHAR(512),
    version       VARCHAR(32)  NOT NULL DEFAULT '0.1.0',
    owner_unit    VARCHAR(128),
    avg_ms        INTEGER      NOT NULL DEFAULT 0,
    runs          INTEGER      NOT NULL DEFAULT 0,
    param_count   INTEGER      NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_report_category ON report(category_id);
CREATE INDEX idx_report_status   ON report(status);
CREATE INDEX idx_report_engine   ON report(engine);

-- Version history per report (config / template / both) — supports rollback
CREATE TABLE report_version (
    id          BIGSERIAL    PRIMARY KEY,
    report_code VARCHAR(64)  NOT NULL REFERENCES report(code) ON DELETE CASCADE,
    version     VARCHAR(32)  NOT NULL,
    change_type VARCHAR(16)  NOT NULL DEFAULT 'both'
                CHECK (change_type IN ('config','template','both')),
    note        VARCHAR(512),
    created_by  VARCHAR(64),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    is_current  BOOLEAN      NOT NULL DEFAULT false
);

CREATE INDEX idx_version_report ON report_version(report_code);
