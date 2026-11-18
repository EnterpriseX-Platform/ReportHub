-- Gateway jobs (Kafka report.jobs lifecycle). The Queue Monitor reads live jobs from here.
CREATE TABLE job (
    id            VARCHAR(32)  PRIMARY KEY,
    report_code   VARCHAR(64)  NOT NULL,
    report_name   VARCHAR(512) NOT NULL,
    stage         VARCHAR(16)  NOT NULL DEFAULT 'queue'
                  CHECK (stage IN ('ingress','queue','worker','jasper','store')),
    state         VARCHAR(16)  NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued','running','done','error')),
    fmt           VARCHAR(8)   NOT NULL DEFAULT 'PDF',
    datasource_id VARCHAR(32),
    requested_by  VARCHAR(64),
    started_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    progress      INTEGER      NOT NULL DEFAULT 0,
    partition     INTEGER      NOT NULL DEFAULT 0,
    priority      VARCHAR(8)   NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('high','normal','low'))
);
CREATE INDEX idx_job_state ON job(state);

-- (No sample jobs seeded — the table fills as reports are run.)
