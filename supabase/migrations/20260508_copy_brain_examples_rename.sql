-- ──────────────────────────────────────────────────────────────────────────────
-- Copy Brain — Calendar Examples
-- Rename label → title and content → description so each example carries the
-- exact two fields a calendar invite has: a title and a rich description.
-- The description column now holds HTML produced by the WYSIWYG editor; it is
-- converted to clean markdown when fed into the LLM prompt.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE sales_assets.copy_brain_examples
  RENAME COLUMN label TO title;

ALTER TABLE sales_assets.copy_brain_examples
  RENAME COLUMN content TO description;

NOTIFY pgrst, 'reload schema';
