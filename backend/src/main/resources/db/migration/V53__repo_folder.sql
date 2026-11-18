-- Folders on the Tables screen become real rows instead of text in repo_table.folder.
--
-- Why: a "parent / child" text path can only group and nest, but
--   1) it cannot store an order - only alphabetical sorting, no drag-to-reorder
--   2) an empty folder (no tables yet) has nowhere to live and disappears on reload
--   3) renaming a folder means updating every row whose path starts with the old name
--
-- repo_table.folder is kept, not dropped - for rollback and as a record of which folder each table
-- used to be in. From now on the screen uses folder_id.
CREATE TABLE repo_folder (
    id         SERIAL PRIMARY KEY,
    menu_key   VARCHAR(64),
    parent_id  INTEGER      REFERENCES repo_folder(id) ON DELETE CASCADE,
    name       VARCHAR(255) NOT NULL,
    sort_order INTEGER      NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX repo_folder_menu_idx ON repo_folder (menu_key, parent_id, sort_order);

ALTER TABLE repo_table ADD COLUMN folder_id INTEGER REFERENCES repo_folder(id) ON DELETE SET NULL;

CREATE INDEX repo_table_folder_idx ON repo_table (folder_id) WHERE is_active;

COMMENT ON TABLE  repo_folder            IS 'Folders in the Tables screen sidebar - nested via parent_id, user drag order in sort_order';
COMMENT ON COLUMN repo_folder.sort_order IS 'Order within the same level, lowest first - as arranged by the user';
COMMENT ON COLUMN repo_table.folder_id   IS 'Folder this table belongs to; NULL = no folder (the old folder column is kept for reference only)';

-- Migrate existing data: split each "parent / child / grandchild" path into folders level by level, then set folder_id on the table
DO $$
DECLARE
    r          RECORD;
    part       TEXT;
    parts      TEXT[];
    parent     INTEGER;
    cur        INTEGER;
    next_order INTEGER;
BEGIN
    FOR r IN
        SELECT DISTINCT menu_key, folder
          FROM repo_table
         WHERE folder IS NOT NULL AND btrim(folder) <> ''
         ORDER BY menu_key, folder
    LOOP
        parts  := string_to_array(r.folder, '/');
        parent := NULL;
        FOREACH part IN ARRAY parts LOOP
            part := btrim(part);
            CONTINUE WHEN part = '';
            SELECT id INTO cur
              FROM repo_folder
             WHERE name = part
               AND menu_key IS NOT DISTINCT FROM r.menu_key
               AND parent_id IS NOT DISTINCT FROM parent;
            IF cur IS NULL THEN
                SELECT COALESCE(MAX(sort_order) + 1, 0) INTO next_order
                  FROM repo_folder
                 WHERE menu_key IS NOT DISTINCT FROM r.menu_key
                   AND parent_id IS NOT DISTINCT FROM parent;
                INSERT INTO repo_folder (menu_key, parent_id, name, sort_order)
                VALUES (r.menu_key, parent, part, next_order)
                RETURNING id INTO cur;
            END IF;
            parent := cur;
        END LOOP;

        UPDATE repo_table
           SET folder_id = parent
         WHERE folder = r.folder
           AND menu_key IS NOT DISTINCT FROM r.menu_key;
    END LOOP;
END $$;
