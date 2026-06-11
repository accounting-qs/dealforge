-- ──────────────────────────────────────────────────────────────────────────────
-- Worker version beacon — detect stale/duplicate worker processes
--
-- Background: a worker process from a pre-May build kept running in production
-- alongside the current one (both poll sales_assets.tasks every 3s). ~40% of
-- lead_list jobs were silently processed by the stale build, producing the dead
-- org-search/classification algorithm's output (few leads) instead of
-- guaranteedLeadSearch's. Nothing surfaced it because both processes look
-- identical from the outside.
--
-- This beacon makes a version split impossible to miss:
--   * tasks.worker_version — every worker stamps its build SHA when it CLAIMS a
--     task. A completed/processing task with worker_version IS NULL means a
--     pre-beacon (stale) worker claimed it → the tell that an old process lives.
--   * worker_heartbeat — each live worker upserts its instance + SHA every 60s,
--     so /api/admin/worker-status can list active versions and flag a conflict.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE sales_assets.tasks ADD COLUMN IF NOT EXISTS worker_version TEXT;

CREATE TABLE IF NOT EXISTS sales_assets.worker_heartbeat (
  instance_id  TEXT        PRIMARY KEY,
  service_name TEXT        NOT NULL DEFAULT '',
  commit_sha   TEXT        NOT NULL DEFAULT '',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT ALL ON sales_assets.worker_heartbeat TO service_role;

NOTIFY pgrst, 'reload schema';
