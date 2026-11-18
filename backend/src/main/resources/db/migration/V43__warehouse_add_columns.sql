-- Let a pipeline widen a target table it is reusing.
--
-- Users should be able to create any table they like, or reuse an existing one and add fields.
-- Creating was already possible (auto_create builds the target from the query result); reusing and
-- widening was not — a query that gained a column failed on the INSERT with "invalid identifier"
-- and the only way out was dropping the table and losing its data.
--
-- Default false on purpose. Adding a column to a table other things may read is not something to
-- do because a SELECT happened to mention a new name: a typo in the query would leave a permanent
-- stray column behind. Off, the load refuses and names the columns; on, it adds them and says so
-- in the run history.

ALTER TABLE warehouse_pipeline
    ADD COLUMN add_columns BOOLEAN NOT NULL DEFAULT false;
