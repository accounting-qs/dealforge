-- ──────────────────────────────────────────────────────────────────────────────
-- Zoom integration config — singleton credentials row
--
-- Stores the Server-to-Server OAuth credentials (Account ID / Client ID /
-- Client Secret) for the company Zoom account. Edited in the app via
-- Settings → Integrations → Zoom (PUT /api/admin/zoom-config) and read at
-- runtime by getZoomCreds() in server.js when minting a Zoom access token.
--
-- Mirrors sales_assets.copy_brain_config: one singleton row in the sales_assets
-- schema with explicit service_role grants (the non-public schema is not
-- auto-granted, so without these INSERT/UPDATE return 42501).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_assets.zoom_config (
  id            BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  account_id    TEXT        NOT NULL DEFAULT '',
  client_id     TEXT        NOT NULL DEFAULT '',
  client_secret TEXT        NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a single empty config row if none exists (safe to re-run).
INSERT INTO sales_assets.zoom_config (account_id, client_id, client_secret)
SELECT '', '', ''
WHERE NOT EXISTS (SELECT 1 FROM sales_assets.zoom_config);

-- service_role needs explicit grants in the sales_assets schema (see copy_brain).
GRANT ALL ON sales_assets.zoom_config TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales_assets.zoom_config_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
