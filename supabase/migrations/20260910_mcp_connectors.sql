-- ──────────────────────────────────────────────────────────────────────────────
-- MCP connectors — one row per connected agent
--
-- Replaces the single-row sales_assets.mcp_config from earlier the same day.
-- The singleton could only ever describe one bot; this lets several stack up
-- under Settings → Integrations → MCP Connectors, each with its own name, its
-- own token, and its own permissions. The name is free text the admin types
-- ("Grok", "Claude Desktop") — Deal Forge has no way to know what is on the far
-- end of a token, so the label is the only thing that identifies it, and
-- last_used_at is what tells you whether it is actually live.
--
-- Per-connector tokens are the point: revoking one bot no longer knocks out the
-- others, and allow_delete can be granted to a trusted connector without
-- granting it everywhere.
--
-- Only sha256(token) is stored, same reasoning as before: every /api/* route in
-- this app is unauthenticated, so a plaintext column would be readable by anyone
-- who can reach the admin endpoint, which would make the bearer check on /mcp
-- pointless. The token is returned exactly once, when the connector is created
-- or rotated.
--
-- Safe to re-run. Any live token in the old singleton is carried over before the
-- table is dropped, so an already-connected bot keeps working.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_assets.mcp_connectors (
  id           BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  -- Admin-supplied label, e.g. "Grok". Not unique: two bots may share a name.
  name         TEXT        NOT NULL,
  -- sha256 hex of the bearer token. Always set — a connector is created with one.
  token_hash   TEXT        NOT NULL,
  -- First 14 chars of the token, so the UI can show which one is which.
  token_prefix TEXT        NOT NULL DEFAULT '',
  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Second gate on delete_job, on top of the per-call confirm flag. Per connector.
  allow_delete BOOLEAN     NOT NULL DEFAULT FALSE,
  last_used_at TIMESTAMPTZ,
  rotated_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Two connectors must never share a token; also makes the auth lookup a
-- single-row match rather than a scan that could ambiguously hit twice.
CREATE UNIQUE INDEX IF NOT EXISTS mcp_connectors_token_hash_key
  ON sales_assets.mcp_connectors (token_hash)
  WHERE token_hash <> '';

-- Carry over a live token from the old singleton, if there is one, so a bot that
-- is already connected does not break. A cleared/never-generated row is skipped.
INSERT INTO sales_assets.mcp_connectors (name, token_hash, token_prefix, enabled, allow_delete, last_used_at, rotated_at)
SELECT COALESCE(NULLIF(c.label, ''), 'Imported connector'),
       c.token_hash, c.token_prefix, c.enabled, c.allow_delete, c.last_used_at, c.rotated_at
FROM sales_assets.mcp_config c
WHERE c.token_hash <> ''
  AND NOT EXISTS (SELECT 1 FROM sales_assets.mcp_connectors m WHERE m.token_hash = c.token_hash);

DROP TABLE IF EXISTS sales_assets.mcp_config;

-- service_role needs explicit grants in the sales_assets schema (see zoom_config).
GRANT ALL ON sales_assets.mcp_connectors TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales_assets.mcp_connectors_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
