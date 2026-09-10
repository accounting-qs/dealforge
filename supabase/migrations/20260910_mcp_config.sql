-- ──────────────────────────────────────────────────────────────────────────────
-- MCP connector config — singleton row
--
-- Backs Settings → Connectors, so the Deal Forge MCP endpoint (/mcp) is managed
-- from the app instead of a Render environment variable. Read at request time by
-- mcp-server.js (30s cache) and edited via:
--   GET  /api/admin/mcp-config          → status, never the token
--   PUT  /api/admin/mcp-config          → enabled / allow_delete / label
--   POST /api/admin/mcp-config/rotate   → mint a new token, returned ONCE
--
-- WHY ONLY A HASH IS STORED
--   Every /api/* route in this app is unauthenticated, so a column holding the
--   token in plaintext would be readable by anyone who can reach
--   GET /api/admin/mcp-config — which would make the bearer check on /mcp
--   pointless. Storing sha256(token) means the endpoint can verify a presented
--   token but nobody can read one back out, the same trade GitHub PATs and
--   Stripe keys make. The full token is shown exactly once, in the response to
--   the rotate call. Lost it → rotate again and re-paste into Grok.
--   token_prefix keeps the first 8 chars so the UI can identify which token is
--   live without being able to reconstruct it.
--
-- DEALFORGE_MCP_TOKEN (env) still works and takes precedence when set, as a
-- break-glass path if the database is unreachable.
--
-- Mirrors sales_assets.zoom_config / sop_config: one singleton row in the
-- sales_assets schema with explicit service_role grants (the non-public schema
-- is not auto-granted, so without these INSERT/UPDATE return 42501).
--
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS + conditional seed, no
-- change to any existing table, no backfill, safe to re-run.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_assets.mcp_config (
  id           BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  -- sha256 hex of the bearer token. '' means no token has been generated yet.
  token_hash   TEXT        NOT NULL DEFAULT '',
  -- First 8 chars of the token, so the UI can show which one is live.
  token_prefix TEXT        NOT NULL DEFAULT '',
  -- Master switch. Off until an admin generates a token and turns it on.
  enabled      BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Second gate on delete_job, on top of the per-call confirm flag.
  allow_delete BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Free-text note, e.g. "Grok bot".
  label        TEXT        NOT NULL DEFAULT '',
  -- Stamped by /mcp on a successful authenticated call (throttled to 1/min).
  last_used_at TIMESTAMPTZ,
  rotated_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a single disabled, token-less row if none exists (safe to re-run).
INSERT INTO sales_assets.mcp_config (token_hash, token_prefix, enabled)
SELECT '', '', FALSE
WHERE NOT EXISTS (SELECT 1 FROM sales_assets.mcp_config);

-- service_role needs explicit grants in the sales_assets schema (see zoom_config).
GRANT ALL ON sales_assets.mcp_config TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales_assets.mcp_config_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
