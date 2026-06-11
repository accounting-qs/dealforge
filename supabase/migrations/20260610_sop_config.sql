-- ──────────────────────────────────────────────────────────────────────────────
-- SOP / training config — singleton row
--
-- Stores the Loom walkthrough URL shown on the public /sop page. Edited in the
-- app via Settings → SOP (PUT /api/admin/sop-config) and read at runtime by the
-- /sop page (GET /api/admin/sop-config), which normalizes the share link to a
-- Loom embed URL.
--
-- Mirrors sales_assets.zoom_config: one singleton row in the sales_assets schema
-- with explicit service_role grants (the non-public schema is not auto-granted,
-- so without these INSERT/UPDATE return 42501).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_assets.sop_config (
  id         BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  loom_url   TEXT        NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a single empty config row if none exists (safe to re-run).
INSERT INTO sales_assets.sop_config (loom_url)
SELECT ''
WHERE NOT EXISTS (SELECT 1 FROM sales_assets.sop_config);

-- service_role needs explicit grants in the sales_assets schema (see zoom_config).
GRANT ALL ON sales_assets.sop_config TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales_assets.sop_config_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
