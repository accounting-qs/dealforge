-- ──────────────────────────────────────────────────────────────────────────────
-- progress_jobs — durable backing for the prefetch / extract-brief progress ids
--
-- These lived only in an in-process Map. That was fine for a rep with a retry
-- button in the New Job UI, and wrong for an agent: an MCP client would
-- prefetch, Render would redeploy, and the follow-up call got a permanent 404
-- with no way to recover. Reported from Grok smoke testing.
--
-- The in-memory Map stays as a write-through cache -- these are polled every
-- second or two and a database round trip per poll is wasted. The table is the
-- fallback when the id is not in this instance's memory, which covers both a
-- redeploy and a second instance picking up the poll.
--
-- extras holds the prefetch candidate cache that extract-brief depends on.
-- It contains a Map in memory, so it is converted to a plain object on write
-- and back on read -- a Map JSON-serialises to {} and would have silently lost
-- every transcript candidate.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_assets.progress_jobs (
  id          UUID        PRIMARY KEY,
  kind        TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'running',
  progress    INTEGER     NOT NULL DEFAULT 0,
  step        TEXT,
  result      JSONB,
  extras      JSONB,
  error       TEXT,
  error_kind  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS progress_jobs_updated_idx ON sales_assets.progress_jobs (updated_at);

GRANT ALL ON sales_assets.progress_jobs TO service_role;

NOTIFY pgrst, 'reload schema';
