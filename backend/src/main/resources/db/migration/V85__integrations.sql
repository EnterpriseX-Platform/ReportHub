-- Integrations: one table for every external connector (IAM, FileHub, notifications, ...).
-- Database connections keep their own table (datasource) and are listed through /integrations too.
CREATE TABLE IF NOT EXISTS connector (
    id              VARCHAR(64)  PRIMARY KEY,
    type            VARCHAR(32)  NOT NULL,   -- database | iam | filehub | object-store | exporter | notify
    name            VARCHAR(200) NOT NULL,
    config          JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- secret values are stored encrypted (enc:v1:...)
    enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
    status          VARCHAR(16)  NOT NULL DEFAULT 'unknown',     -- unknown | healthy | down
    last_checked_at TIMESTAMPTZ,
    last_error      TEXT,
    scope           VARCHAR(16)  NOT NULL DEFAULT 'platform',    -- platform | tenant
    tenant_id       VARCHAR(64),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by      VARCHAR(100),
    CONSTRAINT connector_type_chk CHECK (type IN ('database','iam','filehub','object-store','exporter','notify')),
    CONSTRAINT connector_scope_chk CHECK (scope IN ('platform','tenant'))
);
CREATE INDEX IF NOT EXISTS connector_type_idx ON connector(type);

-- The IAM base URL saved from the old Settings → IAM screen moves into the IAM connector.
INSERT INTO connector (id, type, name, config)
SELECT 'iam', 'iam', 'IAM', jsonb_build_object('baseUrl', s.value)
FROM app_setting s WHERE s.key = 'iam.base-url' AND coalesce(s.value, '') <> ''
ON CONFLICT (id) DO NOTHING;

-- FileHub publication of a stored output / an exported document.
ALTER TABLE output_file ADD COLUMN IF NOT EXISTS filehub_connector_id VARCHAR(64);
ALTER TABLE output_file ADD COLUMN IF NOT EXISTS filehub_file_id VARCHAR(128);
ALTER TABLE output_file ADD COLUMN IF NOT EXISTS filehub_url TEXT;
ALTER TABLE output_file ADD COLUMN IF NOT EXISTS filehub_published_at TIMESTAMPTZ;

ALTER TABLE document ADD COLUMN IF NOT EXISTS filehub_connector_id VARCHAR(64);
ALTER TABLE document ADD COLUMN IF NOT EXISTS filehub_file_id VARCHAR(128);
ALTER TABLE document ADD COLUMN IF NOT EXISTS filehub_url TEXT;
ALTER TABLE document ADD COLUMN IF NOT EXISTS filehub_published_at TIMESTAMPTZ;

-- Per-report automatic delivery after each successful render.
ALTER TABLE report ADD COLUMN IF NOT EXISTS delivery_connector_id VARCHAR(64);
ALTER TABLE report ADD COLUMN IF NOT EXISTS delivery_path VARCHAR(400);

-- Non-fatal problems of a finished job (e.g. FileHub delivery failed); the job itself stays done.
ALTER TABLE job ADD COLUMN IF NOT EXISTS warning TEXT;
