-- Engines are pluggable/installable now (jasper, component, http, aspose, JAR plugins, …), so the
-- report.engine column must not be locked to a fixed enum. Drop the CHECK and widen the column.
-- Engine validity is enforced at runtime by the EngineResolver against the engine registry.
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_engine_check;
ALTER TABLE report ALTER COLUMN engine TYPE VARCHAR(32);
