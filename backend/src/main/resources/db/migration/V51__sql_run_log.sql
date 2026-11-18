-- History of free-form SQL runs (Ad-hoc SQL tab and the Tables screen).
--
-- The SQL box can execute INSERT/UPDATE/DELETE/MERGE and PL/SQL blocks (see
-- RepositoryService.classify), so we keep a trail of who ran what, when, and against which datasource.
--
-- Both successful and failed runs are recorded; failed runs are the ones read most often.
create table if not exists sql_run_log (
    id             bigserial primary key,
    datasource_id  varchar(64),
    statement_kind varchar(16)  not null,          -- select | update | block
    sql_text       text         not null,
    row_count      integer,                        -- select: rows read
    affected       integer,                        -- update: rows affected
    duration_ms    integer      not null,
    status         varchar(8)   not null,          -- ok | error
    error_text     text,
    source         varchar(16),                    -- adhoc | tables
    created_by     varchar(120),
    created_at     timestamptz  not null default now()
);

-- The history screen always reads newest first, sometimes filtered per user.
create index if not exists idx_sql_run_log_created on sql_run_log (created_at desc);
create index if not exists idx_sql_run_log_user on sql_run_log (created_by, created_at desc);
