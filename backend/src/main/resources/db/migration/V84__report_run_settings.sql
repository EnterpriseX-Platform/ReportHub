-- Per-report run settings set on the register/config screens.
ALTER TABLE report ADD COLUMN IF NOT EXISTS priority VARCHAR(8) NOT NULL DEFAULT 'normal';
ALTER TABLE report ADD COLUMN IF NOT EXISTS timeout_minutes INTEGER;
ALTER TABLE report ADD COLUMN IF NOT EXISTS queue VARCHAR(64);

-- Datasource passwords are stored encrypted (AES-GCM, see EncryptionService); ciphertext is longer.
ALTER TABLE datasource ALTER COLUMN db_password TYPE VARCHAR(1024);

-- Canonical datasource engine names.
UPDATE datasource SET engine = CASE
    WHEN lower(engine) LIKE '%postgres%' OR lower(engine) IN ('pg', 'pgsql') THEN 'POSTGRES'
    WHEN lower(engine) LIKE '%oracle%' THEN 'ORACLE'
    WHEN lower(engine) LIKE '%mysql%' OR lower(engine) LIKE '%mariadb%' THEN 'MYSQL'
    WHEN lower(engine) LIKE '%sqlserver%' OR lower(engine) LIKE '%sql server%' OR lower(engine) LIKE '%mssql%' THEN 'SQLSERVER'
    WHEN lower(engine) LIKE '%rest%' OR lower(engine) LIKE '%soap%' THEN 'REST'
    ELSE upper(engine) END;
