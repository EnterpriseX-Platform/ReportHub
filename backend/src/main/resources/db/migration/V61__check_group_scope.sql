-- User-defined data scope for a check group. Previously the scope was inferred from members' SQL
-- (the FROM clause and the conditions most members share), so it was read-only.
--
-- Once set, rules refer to it via the $SCOPE variable (FROM $SCOPE instead of a table name),
-- so changing the scope once applies to every check in the group.
CREATE TABLE IF NOT EXISTS check_group_scope (
    folder        VARCHAR(200) PRIMARY KEY,   -- group name; '' = ungrouped
    source        TEXT        NOT NULL,       -- table name (e.g. STAGING.DATA_CHECK) or a full SELECT
    conditions    TEXT,                       -- shared conditions, one per line (joined with AND)
    datasource_id VARCHAR(80),                -- connection used to count rows in scope
    updated_at    TIMESTAMPTZ,
    updated_by    VARCHAR(120)
);
