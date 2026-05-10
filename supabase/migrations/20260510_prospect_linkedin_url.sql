-- Adds prospect_linkedin_url to sales_assets.jobs so prospect_research has
-- something to read. Safe to apply more than once.
--
-- Source of the field at job creation:
--   1. GHL contact lookup (custom field whose name contains "linkedin")
--   2. Apollo people/match by email (when GHL returns nothing)
--   3. Manual rep entry via PATCH /api/jobs/:id/prospect-info (Prospect Infos tab)

ALTER TABLE sales_assets.jobs
  ADD COLUMN IF NOT EXISTS prospect_linkedin_url text;
