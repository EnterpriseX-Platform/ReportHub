-- Where the target table lives, when that is not the target connection's own schema.
--
-- targetSchema() resolved the schema from the connection, so a pipeline could only ever write into
-- the account's own schema. A pipeline may need to land in another schema on the same database
-- (e.g. a STAGING schema), which was unreachable.
--
-- NULL keeps the previous behaviour: the connection's schema on Oracle, the default on Postgres.
ALTER TABLE warehouse_pipeline ADD COLUMN target_schema VARCHAR(64);

COMMENT ON COLUMN warehouse_pipeline.target_schema IS
  'Schema of the target table; NULL = the target connection''s own schema';
