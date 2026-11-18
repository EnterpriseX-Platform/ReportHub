-- Which tables a data screen offers, instead of every table the connection can see.
--
-- Pointing the screen straight at a datasource can list thousands of tables, which is not a
-- screen anyone can work with. An admin now picks the tables that belong on a screen and gives
-- each one a label; the screen shows that list.
--
-- eq_filter holds the fixed slice a screen is meant to show, as COLUMN=value pairs separated by
-- ';' (e.g. REGION=north for a regional slice of a registry). It is passed
-- to the rows endpoint as bound values against catalog-checked columns, never spliced into SQL.
--
-- menu_key ties an entry to the portal menu that opens it (the host app's menu link carries ?menu=<key>),
-- so one screen serves several menus without a code change per menu.
CREATE TABLE repo_table (
    id            SERIAL PRIMARY KEY,
    menu_key      VARCHAR(64),
    label         VARCHAR(255) NOT NULL,
    datasource_id VARCHAR(32)  NOT NULL,
    schema_name   VARCHAR(64),
    table_name    VARCHAR(128) NOT NULL,
    eq_filter     VARCHAR(1000),
    sort_order    INTEGER      NOT NULL DEFAULT 0,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX repo_table_menu_key_idx ON repo_table (menu_key) WHERE is_active;

-- Demo entries: an export table and two lookup registries.
INSERT INTO repo_table (menu_key, label, datasource_id, schema_name, table_name, eq_filter, sort_order) VALUES
 ('review', 'Sales export',        'demo', 'CORE', 'SALES_EXPORT', NULL, 1),
 ('review', 'Product categories',  'demo', 'CORE', 'M_CATEGORY',   'STATUS=active', 2),
 ('review', 'Branch registry',     'demo', 'CORE', 'M_BRANCH',     NULL, 3),
 ('review', 'Branch registry (north)', 'demo', 'CORE', 'M_BRANCH', 'REGION=north', 4);
