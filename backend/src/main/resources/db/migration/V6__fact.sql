-- Warehouse / Analytics fact table backing the server-side Pivot and Ad-hoc compute.
-- Empty by default — load your own rows so the Analytics Workbench and Ad-hoc Builder
-- run over real data. Amounts are intended as THB millions but the table is domain-agnostic.
CREATE TABLE fact (
    id          BIGSERIAL    PRIMARY KEY,
    region      VARCHAR(64)  NOT NULL,
    category    VARCHAR(64)  NOT NULL,
    channel     VARCHAR(64)  NOT NULL,
    fiscal_year VARCHAR(8)   NOT NULL,
    target      BIGINT       NOT NULL,   -- target amount
    sales       BIGINT       NOT NULL,   -- actual sales
    profit      BIGINT       NOT NULL    -- net profit
);

CREATE INDEX idx_fact_year    ON fact(fiscal_year);
CREATE INDEX idx_fact_region  ON fact(region);
CREATE INDEX idx_fact_channel ON fact(channel);

-- (No sample fact data seeded.)
