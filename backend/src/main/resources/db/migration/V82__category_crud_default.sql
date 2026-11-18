-- Report categories become user-managed (CRUD API) and a fresh install gets one default
-- category so reports can be registered right away.
ALTER TABLE report_category ADD COLUMN IF NOT EXISTS description VARCHAR(1000);
ALTER TABLE report_category ALTER COLUMN min_reports SET DEFAULT 0;

INSERT INTO report_category (id, ref, name, min_reports, sort_order, tenant_id, project_id, description)
SELECT 'general', 'GEN', 'General', 0, 0, 'default', 'default', 'Default category'
WHERE NOT EXISTS (SELECT 1 FROM report_category WHERE tenant_id = 'default' AND project_id = 'default')
ON CONFLICT (id) DO NOTHING;

-- A newly created connection is 'unknown' until it is tested.
ALTER TABLE datasource DROP CONSTRAINT IF EXISTS datasource_status_check;
ALTER TABLE datasource ADD CONSTRAINT datasource_status_check
    CHECK (status IN ('healthy', 'degraded', 'down', 'unknown'));
