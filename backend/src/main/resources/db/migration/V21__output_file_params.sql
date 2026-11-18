-- Render call history: store the run parameters used to produce each output file, alongside
-- the existing created_by (caller). Lets the Output Files menu show "produced by params X,
-- called by user Y". Nullable: legacy rows + recover/retry runs (which carry no params) stay NULL.
ALTER TABLE output_file ADD COLUMN params TEXT;
