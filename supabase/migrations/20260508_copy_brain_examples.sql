-- ──────────────────────────────────────────────────────────────────────────────
-- Copy Brain — Examples table (Lever 4.1 from the quality plan)
--
-- Few-shot examples that fill the {{examples_block}} placeholder in
-- prompts/webinar_titles_system.txt. Same shape as copy_brain_principles
-- (toggle, position, individual edit) so the admin UX matches.
--
-- Each example has:
--   label   — short title shown in the list (e.g. "Calendar invite — B2B SaaS")
--   content — full markdown body that Claude sees verbatim. Markdown preserved
--             so headers, lists, and emphasis carry the example's STRUCTURE
--             into the prompt, not just the words.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_assets.copy_brain_examples (
  id          BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  label       TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  position    INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS copy_brain_examples_position_idx
  ON sales_assets.copy_brain_examples (position);

-- Same grant pattern as the other copy_brain tables — service_role needs explicit
-- INSERT/UPDATE/DELETE in the sales_assets schema.
GRANT ALL ON sales_assets.copy_brain_examples TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales_assets.copy_brain_examples_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
