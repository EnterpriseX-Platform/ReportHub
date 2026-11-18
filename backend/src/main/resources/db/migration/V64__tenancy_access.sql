-- Multi-tenancy + projects, object ACLs (level 2) and row-level filters (level 3).
-- Existing installs: everything is backfilled into tenant "default" / project "default".

CREATE TABLE tenant (
    id            VARCHAR(64)  PRIMARY KEY,
    name          VARCHAR(200) NOT NULL,
    iam_tenant_id VARCHAR(64)  UNIQUE,
    active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE project (
    tenant_id    VARCHAR(64)  NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id           VARCHAR(64)  NOT NULL,
    name         VARCHAR(200) NOT NULL,
    iam_app_code VARCHAR(100),
    active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id)
);

INSERT INTO tenant (id, name) VALUES ('default', 'Default');
INSERT INTO project (tenant_id, id, name) VALUES ('default', 'default', 'Default');

-- Owned entities: tenant_id + project_id with the default backfill.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
      'report', 'report_category', 'datasource', 'dataset_def', 'repo_table', 'repo_folder',
      'warehouse_pipeline', 'etl_chain', 'data_check', 'scheduler', 'dashboard',
      'output_file', 'job', 'saved_view', 'workspace', 'param_def', 'sql_run_log', 'adhoc_run_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id VARCHAR(64) NOT NULL DEFAULT ''default''', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN project_id VARCHAR(64) NOT NULL DEFAULT ''default''', t);
    EXECUTE format('CREATE INDEX %I ON %I (tenant_id, project_id)', 'ix_' || t || '_scope', t);
  END LOOP;
END $$;

-- Built-in users belong to a tenant too (IAM users get theirs from IAM).
ALTER TABLE app_user ADD COLUMN tenant_id VARCHAR(64) NOT NULL DEFAULT 'default' REFERENCES tenant(id);

-- Who submitted a job (roles + attributes), so the render worker applies the same row filters.
ALTER TABLE job ADD COLUMN principal_json TEXT;

CREATE TABLE app_setting (
    key        VARCHAR(100) PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE acl_entry (
    id             BIGSERIAL    PRIMARY KEY,
    tenant_id      VARCHAR(64)  NOT NULL DEFAULT 'default',
    project_id     VARCHAR(64)  NOT NULL DEFAULT 'default',
    object_type    VARCHAR(32)  NOT NULL,
    object_id      VARCHAR(200) NOT NULL,
    principal_type VARCHAR(32)  NOT NULL CHECK (principal_type IN ('role', 'responsibility', 'user')),
    principal_code VARCHAR(200) NOT NULL,
    permission     VARCHAR(16)  NOT NULL CHECK (permission IN ('view', 'run', 'edit')),
    created_by     VARCHAR(200),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX ix_acl_entry_object ON acl_entry (tenant_id, project_id, object_type, object_id);

CREATE TABLE row_filter_rule (
    id             BIGSERIAL     PRIMARY KEY,
    tenant_id      VARCHAR(64)   NOT NULL DEFAULT 'default',
    project_id     VARCHAR(64)   NOT NULL DEFAULT 'default',
    object_type    VARCHAR(32)   NOT NULL CHECK (object_type IN ('REPORT', 'DATASET', 'REPO_TABLE')),
    object_id      VARCHAR(200)  NOT NULL,
    column_name    VARCHAR(128)  NOT NULL,
    operator       VARCHAR(16)   NOT NULL,
    value_expr     VARCHAR(1000),
    value_type     VARCHAR(16)   NOT NULL DEFAULT 'text',
    principal_type VARCHAR(32),
    principal_code VARCHAR(200),
    enabled        BOOLEAN       NOT NULL DEFAULT TRUE,
    created_by     VARCHAR(200),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX ix_row_filter_rule_object ON row_filter_rule (tenant_id, project_id, object_type, object_id);

-- report.allowed_roles (CSV of role codes) becomes ACL rows: role → run.
INSERT INTO acl_entry (tenant_id, project_id, object_type, object_id, principal_type, principal_code, permission, created_by)
SELECT r.tenant_id, r.project_id, 'REPORT', r.code, 'role', trim(x.code), 'run', 'migration'
FROM report r
CROSS JOIN LATERAL unnest(string_to_array(r.allowed_roles, ',')) AS x(code)
WHERE r.allowed_roles IS NOT NULL AND trim(x.code) <> '';

COMMENT ON COLUMN report.allowed_roles IS 'Deprecated: superseded by acl_entry (object_type=REPORT). Kept in sync on save.';
