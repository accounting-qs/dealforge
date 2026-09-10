-- ──────────────────────────────────────────────────────────────────────────────
-- jobs.portal_version — which portal flow a job was created under
--
-- V2 (case-study swaps, the 9-slide webinar deck, Calendar Invite sub-tabs) is
-- built alongside V1 rather than replacing it, so sales reps keep the flow they
-- know while V2 is proved out. The flow is pinned PER JOB, not per user: the app
-- has no login, so a per-user preference could not be enforced, and pinning per
-- job also means an old job keeps rendering the way it was generated.
--
-- Default 'v1' — every existing job and every rep-created job stays on the
-- current flow until someone deliberately picks V2 in the New Job modal.
--
-- Real column rather than a key inside extracted_data: the dashboard lists 100
-- jobs at a time and needs to badge and filter on this without pulling the whole
-- brief blob for every row.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE sales_assets.jobs
  ADD COLUMN IF NOT EXISTS portal_version TEXT NOT NULL DEFAULT 'v1';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_portal_version_check') THEN
    ALTER TABLE sales_assets.jobs
      ADD CONSTRAINT jobs_portal_version_check CHECK (portal_version IN ('v1','v2'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS jobs_portal_version_idx ON sales_assets.jobs (portal_version);

NOTIFY pgrst, 'reload schema';
