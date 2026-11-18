-- Saved scripts can be private ("only me") or public ("everyone").
--
-- Previously /views never filtered by owner, so one user's experimental scripts showed up in
-- everyone's sidebar.
--
-- The default for new rows is false (private), but **existing rows become public** so nothing
-- people already see disappears on deploy (many old rows have created_by = anonymous).
ALTER TABLE saved_view ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
UPDATE saved_view SET is_public = true WHERE is_public = false;

-- The sidebar always reads by kind + owner/public.
CREATE INDEX IF NOT EXISTS idx_saved_view_kind_owner ON saved_view (kind, created_by, is_public);
