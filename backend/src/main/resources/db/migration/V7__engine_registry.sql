-- Installed report engines. The core resolves an engine for each report, then the report-specific
-- "custom" separately — engines are pluggable (built-in, remote URL, or JAR/lib plugin).
CREATE TABLE engine_instance (
    id               BIGSERIAL    PRIMARY KEY,
    name             VARCHAR(128) NOT NULL,
    kind             VARCHAR(32)  NOT NULL,          -- matches a ReportEngine.kind(): jasper | component | http | aspose | ...
    install_method   VARCHAR(16)  NOT NULL DEFAULT 'builtin'
                     CHECK (install_method IN ('builtin','url','jar','lib','service')),
    base_url         VARCHAR(512),                   -- for url/service engines
    auth_token       VARCHAR(1024),                  -- secret; supply from config/vault, not the UI in prod
    component_format VARCHAR(32),                    -- e.g. 'yml' for the OneWeb component engine
    artifact_ref     VARCHAR(512),                   -- jar path / maven coordinate for jar|lib installs
    enabled          BOOLEAN      NOT NULL DEFAULT true,
    note             VARCHAR(512),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_engine_kind ON engine_instance(kind) WHERE enabled;

-- The built-in local engine (Jasper PDF + POI XLSX + CSV + SQL/Postgres). Always present.
INSERT INTO engine_instance (name, kind, install_method, enabled, note)
VALUES ('Local Jasper', 'jasper', 'builtin', true, 'In-process JasperReports + POI + CSV + SQL — light, no Aspose/LibreOffice');
