-- Who may see a report in the registry list.
--
-- Comma-separated identity-provider role codes (the same codes the portal menu is keyed on,
-- e.g. 'ANALYST,MANAGER'). NULL or empty means every caller sees it, which
-- is why every existing row stays visible without a backfill.
--
-- Only enforced for callers who arrived through the portal, because that is the
-- only path that carries an identity-provider identity (EdgeBearerAuthFilter reads the roles
-- claim off the gateway-injected token). A direct admin/admin login has no portal
-- roles to check against and keeps seeing the whole registry.
ALTER TABLE report ADD COLUMN allowed_roles VARCHAR(1000);

COMMENT ON COLUMN report.allowed_roles IS
  'CSV of role codes allowed to see this report from the portal; NULL/empty = everyone';
