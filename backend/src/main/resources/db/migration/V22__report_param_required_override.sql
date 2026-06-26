-- Per-report "required" override (Tawan request 4): the register-report screen can mark which fields
-- are required for THIS report, on top of the central param_def.required. Nullable on purpose:
--   NULL  = not configured for this report -> NOT enforced at run (preserves today's behavior, so no
--           existing run starts failing just because a central param is required).
--   true  = required for this report (the UI pre-fills central-required params as true when configuring).
--   false = explicitly optional for this report.
-- Run-time enforcement (ParameterService.validateRequired) keys off required_override = true only, so
-- enforcement is opt-in per report and never retroactively breaks reports nobody has configured.
ALTER TABLE report_param ADD COLUMN required_override BOOLEAN;
