-- Share a generated report file via a link so people outside the system can open it without logging in.
--
-- Stored on output_file itself rather than a separate table: one file has at most one link, and revoking clears the token
-- (if multiple links per file or per-person permissions are needed later, move this to a separate share table).
ALTER TABLE output_file ADD COLUMN IF NOT EXISTS share_token      varchar(64);
ALTER TABLE output_file ADD COLUMN IF NOT EXISTS share_expires_at timestamptz;
ALTER TABLE output_file ADD COLUMN IF NOT EXISTS shared_by        varchar(255);
ALTER TABLE output_file ADD COLUMN IF NOT EXISTS shared_at        timestamptz;
-- Number of times the link was opened - the owner should know how much it was used before revoking it.
ALTER TABLE output_file ADD COLUMN IF NOT EXISTS share_hits       integer NOT NULL DEFAULT 0;

-- Looked up by token on every open; unique so two files cannot share a token.
CREATE UNIQUE INDEX IF NOT EXISTS idx_output_file_share_token
    ON output_file (share_token) WHERE share_token IS NOT NULL;
