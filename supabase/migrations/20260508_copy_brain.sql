-- ──────────────────────────────────────────────────────────────────────────────
-- Copy Brain — V1 schema (calendar invite copy generation)
--
-- Two tables in the sales_assets schema:
--   copy_brain_principles — editable list of copywriting principles, toggleable
--   copy_brain_config     — singleton row holding business_context + format_rules
--
-- Consumed at runtime by generateWebinarTitles() in server.js to fill the
-- {{business_context_block}}, {{format_rules_block}}, {{principles_block}}
-- placeholders in prompts/webinar_titles_system.txt.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_assets.copy_brain_principles (
  id          BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  text        TEXT        NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  position    INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS copy_brain_principles_position_idx
  ON sales_assets.copy_brain_principles (position);

CREATE TABLE IF NOT EXISTS sales_assets.copy_brain_config (
  id                BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  business_context  TEXT        NOT NULL DEFAULT '',
  format_rules      TEXT        NOT NULL DEFAULT '',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a singleton config row if none exists
INSERT INTO sales_assets.copy_brain_config (business_context, format_rules)
SELECT
$BC$## QS Business Context

**Company**: Attract & Scale (QS)
**Owner**: Lloyd Yip
**Mission**: Help online coaches get more high-ticket clients through paid social ads — specifically Meta/Facebook.

## Ideal Client Profile (ICP)
- Online coaches, consultants, and course creators
- Selling programs/services $2k-$20k
- Already running Meta/Facebook ads or ready to start
- Want predictable, scalable client acquisition (not referrals or organic-only)

## Voice & Positioning
- Direct-response, outcome-led, no fluff
- Speak as if the prospect company is hosting the webinar — never as QS
- Always lead with the client's problem or outcome, not credentials
$BC$,
$FR$# Calendar Blocker Description — 9-Part Structure

Use this structure when writing the calendar invite description.
Max 300 words total. Each part is one tight sentence or short paragraph.

1. CONDITIONAL OPENER — "If you run [segment] and your growth still depends on [painful
   current state] — this will fix it." Qualifies the reader, diagnoses their pain, makes
   a bold promise. Frame as invitation to self-identify, not a declaration of pain.

2. CLIENT PROOF STORY — One client. Segment-matched. Specific before/after numbers.
   Structure: [Name] → [before state] → [used the system] → [result with verbatim numbers].
   Never fabricate numbers. If no case study, skip to Part 3.

3. CONTRAST FRAME — "Instead of [what they stopped doing], [name] built [new system] —
   [what that system does]." Names the old way vs. the new way. Crystallises the value prop.

4. SESSION PROMISE — "[Prospect company] will show you exactly how [they/client name] did
   this." Commits to a specific mechanism. Educational framing, not a pitch.

5. YES / MAYBE / UNSUBSCRIBE / REGISTRATION LINK (non-negotiable) — Comes BEFORE bullets.
   Include all three elements:
   "Click 'YES' or 'MAYBE' to confirm your attendance. Click Unsubscribe and we won't
   reach out again. Or visit the official registration page to sign up there."
   YES/MAYBE = low-friction conversion (one click, no form). Unsubscribe = compliance +
   trust signal. Registration page = second pathway for standard funnel tracking.

6. DISCOVERY BULLETS — 4–5 bullets. Each is a transformation promise, not a topic.
   Wrong: "Webinar structure" (topic). Right: "Structure your webinar so prospects show up
   already convinced and ready to buy" (transformation). Prefix with 💥 or 🚀.

7. REFRAME LINE — "Most [segment] don't have a [obvious problem] — they have a [real
   underlying problem]." Pattern interrupt. Repositions the host as a diagnostician.

8. COMPETITIVE URGENCY CLOSE — "The [segment] winning in 2026 aren't doing [old approach]…
   They're building [new system] that generates [result] on repeat." No false scarcity.

9. P.S. REPLAY HOOK — "P.S. Want the replay? Just register through the official page."
   Removes FOMO friction. Increases total registrations.
$FR$
WHERE NOT EXISTS (SELECT 1 FROM sales_assets.copy_brain_config);

-- Seed principles only if the table is empty (safe to re-run)
INSERT INTO sales_assets.copy_brain_principles (text, enabled, position)
SELECT * FROM (VALUES
  ('Always lead with the client''s problem or outcome — never with QS''s name or credentials.', TRUE, 1),
  ('Hooks must stop the scroll in under 3 seconds. If it doesn''t make someone pause, rewrite it.', TRUE, 2),
  ('Facebook ad hooks must be 1–3 lines. Bold claim, unexpected stat, or agitated pain point.', TRUE, 3),
  ('For retargeting ads: lead with social proof (''Our clients average X calls booked per week after switching to our system'').', TRUE, 4),
  ('End every Facebook ad CTA with a single specific action. ''Comment ADS below'' or ''Book your call at [link]'' — not both.', TRUE, 5),
  ('Use curiosity gaps in cold traffic ads: ''The one thing coaches miss that doubles their show-up rate...''', TRUE, 6),
  ('Event titles must work at a glance in a calendar grid — 40–60 chars, lead with outcome not format.', TRUE, 7),
  ('The first 2 lines of a description are preview text. Write them to stand alone without reading the rest.', TRUE, 8),
  ('For discovery/strategy calls: include ''what to prepare'' so prospects show up ready. Reduces no-shows.', TRUE, 9)
) AS seed(text, enabled, position)
WHERE NOT EXISTS (SELECT 1 FROM sales_assets.copy_brain_principles);

-- Grant the Supabase API role full access on the new tables + identity sequences.
-- The sales_assets schema does not auto-grant to service_role like public does;
-- without these, GETs work via implicit SELECT but INSERT/UPDATE/DELETE 42501.
GRANT ALL ON sales_assets.copy_brain_principles TO service_role;
GRANT ALL ON sales_assets.copy_brain_config     TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales_assets.copy_brain_principles_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales_assets.copy_brain_config_id_seq     TO service_role;

NOTIFY pgrst, 'reload schema';
