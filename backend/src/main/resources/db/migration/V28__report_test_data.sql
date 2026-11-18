-- Register Report screen: mark a report as holding test data .
-- Shown as a note under the owner unit on the report overview when true.
ALTER TABLE report ADD COLUMN test_data BOOLEAN NOT NULL DEFAULT FALSE;
