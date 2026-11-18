-- Template file versioning: keep upload history instead of deleting on replace.
-- active = TRUE means this file is used by the render worker; FALSE = historical record.
ALTER TABLE report_unit_file ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE;
