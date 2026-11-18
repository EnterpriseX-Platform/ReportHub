-- Numeric columns of a dataset that should group (dimension) rather than sum (measure), e.g. a
-- numeric year or code column. Explicit per dataset: kinds are never guessed from column names.
-- Comma-separated column names; NULL = numeric columns are measures, everything else dimensions.
ALTER TABLE dataset_def ADD COLUMN IF NOT EXISTS dimension_columns VARCHAR(2000);
