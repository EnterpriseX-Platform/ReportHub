-- Mark one datasource as the default (used as the fallback connection and pre-selected in pickers).
-- At most one row is default; the invariant is enforced in CatalogService.setDefault (single writer).
ALTER TABLE datasource ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE;
