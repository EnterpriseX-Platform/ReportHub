-- Check batch: running a whole group once = one batch; every check in it shares the same id.
--
-- Previously results were stored per check with nothing linking checks run together, so "what did
-- this run find" had to be guessed from timestamps (a batch spans minutes because checks run one by one).
alter table data_check_run add column if not exists batch_id varchar(40);

-- Used to list a group's batches newest first.
create index if not exists idx_data_check_run_batch on data_check_run (batch_id, started_at desc);
