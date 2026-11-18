-- Documents join tenancy (V64): every document and document asset belongs to one tenant + project.
-- Existing rows are backfilled into the default tenant/project.
ALTER TABLE document ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE document ADD COLUMN IF NOT EXISTS project_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS ix_document_scope ON document (tenant_id, project_id);

ALTER TABLE document_asset ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE document_asset ADD COLUMN IF NOT EXISTS project_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS ix_document_asset_scope ON document_asset (tenant_id, project_id);
