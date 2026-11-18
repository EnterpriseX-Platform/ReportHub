-- Generated report outputs persisted in object storage (MinIO).
CREATE TABLE output_file (
    id          BIGSERIAL    PRIMARY KEY,
    object_key  VARCHAR(512) NOT NULL UNIQUE,
    report_code VARCHAR(64)  NOT NULL,
    job_id      VARCHAR(32),
    fmt         VARCHAR(8)   NOT NULL DEFAULT 'PDF',
    size_bytes  BIGINT       NOT NULL DEFAULT 0,
    created_by  VARCHAR(64),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_output_file_created_at ON output_file(created_at DESC);
CREATE INDEX idx_output_file_report_code ON output_file(report_code);
