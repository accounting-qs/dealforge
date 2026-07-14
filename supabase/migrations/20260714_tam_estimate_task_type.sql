-- ──────────────────────────────────────────────────────────────────────────────
-- tam_estimate task type
--
-- Adds 'tam_estimate' to the sales_assets.tasks.task_type CHECK constraint so the
-- new Stage-2 pipeline task (LLM-broadened Apollo TAM estimate) can be inserted.
--
-- ADDITIVE + REVERSIBLE: only widens the set of allowed values; touches no
-- existing rows. tasks_status_check already includes 'needs_input'/'skipped', so
-- no status change is needed.
--
-- Consumed at runtime by handleTamEstimate() in server.js (dispatch switch +
-- Stage-2 spawn list). See specs/tam_estimate.md.
--
-- Revert:
--   ALTER TABLE sales_assets.tasks DROP CONSTRAINT tasks_task_type_check;
--   ALTER TABLE sales_assets.tasks ADD CONSTRAINT tasks_task_type_check
--     CHECK (task_type = ANY (ARRAY['extract','prospect_research','brand_scrape',
--       'lead_list','webinar_titles','roi_model','calendar_visual','webinar_mock']));
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE sales_assets.tasks DROP CONSTRAINT tasks_task_type_check;

ALTER TABLE sales_assets.tasks ADD CONSTRAINT tasks_task_type_check
  CHECK (task_type = ANY (ARRAY[
    'extract',
    'prospect_research',
    'brand_scrape',
    'lead_list',
    'webinar_titles',
    'roi_model',
    'calendar_visual',
    'webinar_mock',
    'tam_estimate'
  ]));
