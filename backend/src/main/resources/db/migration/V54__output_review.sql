-- A reviewer can confirm that a processed output has been checked.
-- Confirmation is stored per file, not per report: one report can produce many files, and the
-- confirmation must bind to the file the reviewer actually saw, not a later file that replaced it.
create table if not exists output_review (
    object_key   varchar(512) primary key
                 references output_file (object_key) on delete cascade,
    report_code  varchar(64)  not null,
    confirmed_by varchar(64)  not null,
    confirmed_at timestamptz  not null default now(),
    note         varchar(500)
);

create index if not exists idx_output_review_report on output_review (report_code);
create index if not exists idx_output_review_at on output_review (confirmed_at desc);
