-- m_branch: master branch table — mirrors a typical reporting structure so parameter
-- dropdowns can pull branch options from it (allowlisted as a query source in ParameterService).
-- Columns follow common conventions: branch_code (PK), branch_name, region_code (FK → ref_region).
-- Seeded initially from ref_branch so the param catalog works immediately;
-- replace / append rows via the Datasets SQL editor or an import from your warehouse.
CREATE TABLE m_branch (
    branch_code    VARCHAR(16)  PRIMARY KEY,
    branch_name VARCHAR(255) NOT NULL,
    region_code    VARCHAR(8)   REFERENCES ref_region(code)
);
CREATE INDEX idx_m_branch_region_code ON m_branch(region_code);

INSERT INTO m_branch (branch_code, branch_name, region_code)
SELECT code, name, region_code FROM ref_branch;
