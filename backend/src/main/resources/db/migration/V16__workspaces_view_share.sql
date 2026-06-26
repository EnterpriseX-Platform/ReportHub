-- Workspaces group analytics assets (saved views + dashboards); views/dashboards get a
-- folder path for tree organization, and saved views get a public share token so a view
-- can serve its data as CSV/XLSX/JSON to external consumers.
CREATE TABLE workspace (
    id         BIGSERIAL    PRIMARY KEY,
    name       VARCHAR(128) NOT NULL UNIQUE,
    created_by VARCHAR(64),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
INSERT INTO workspace (name, created_by) VALUES ('General', 'system');

ALTER TABLE saved_view ADD COLUMN workspace_id BIGINT REFERENCES workspace(id);
ALTER TABLE saved_view ADD COLUMN folder       VARCHAR(255);
ALTER TABLE saved_view ADD COLUMN share_token  VARCHAR(64) UNIQUE;
ALTER TABLE dashboard  ADD COLUMN workspace_id BIGINT REFERENCES workspace(id);
ALTER TABLE dashboard  ADD COLUMN folder       VARCHAR(255);

UPDATE saved_view SET workspace_id = (SELECT id FROM workspace WHERE name='General');
UPDATE dashboard  SET workspace_id = (SELECT id FROM workspace WHERE name='General');
