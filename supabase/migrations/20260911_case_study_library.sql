-- ──────────────────────────────────────────────────────────────────────────────
-- Case-study library — mirrored from the "Customer Testimonials" Airtable base
--
-- Airtable stays the place humans edit. Deal Forge syncs a read-only copy here so
-- the pipeline and portal can query it without an Airtable round-trip per render,
-- and so a webinar/invite still builds when Airtable is down or rate-limited.
--
-- Three tables mirroring the three Airtable tables:
--   case_study_clients      — the library. Drives V2 on Lead List, Calendar
--                             Invite, Webinar Experience and ROI Model.
--   case_study_transcripts  — the recorded client interviews.
--   case_study_clips        — cut highlights from those interviews.
--
-- WHY airtable_record_id IS THE KEY
--   Names are not stable (they get corrected) and Airtable rows have no other
--   durable identity. Upserting on the record id means a re-sync updates in
--   place instead of duplicating the library every run.
--
-- WHY IMAGE URLS ARE RE-HOSTED, NOT MIRRORED
--   Airtable attachment URLs are short-lived signed links that expire in hours.
--   Storing them would mean every client logo in the portal breaks the same day,
--   silently. The sync downloads each attachment into the existing sales-assets
--   Storage bucket under case-studies/<record_id>/ and stores THAT url.
--   *_source_name keeps the original filename so a re-sync can tell if it changed.
--
-- Numbers are stored exactly as Airtable holds them and are nullable throughout:
-- most rows have rich narrative but no campaign stats, and a fabricated zero
-- would read as a real result of zero. Never coalesce these to 0 on display.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_assets.case_study_clients (
  id                  BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  airtable_record_id  TEXT        NOT NULL UNIQUE,

  -- Identity
  client_name         TEXT        NOT NULL,
  company             TEXT,
  website             TEXT,
  record_type         TEXT,                     -- Airtable "Type", e.g. "Case study (video testimonial)"
  headshot_url        TEXT,                     -- re-hosted in Supabase Storage
  headshot_source_name TEXT,
  logo_url            TEXT,                     -- re-hosted in Supabase Storage
  logo_source_name    TEXT,
  logo_type           TEXT,                     -- logo | wordmark in portrait | none
  headshot_source     TEXT,

  -- Narrative — what a rep reads aloud
  problem_they_solve  TEXT,
  how_they_help       TEXT,
  best_used_for       TEXT,
  who_they_are        TEXT,
  key_quote           TEXT,

  -- Match axes (Alex's rule: one client by TAM, one by offering, one by model)
  industries          TEXT,
  titles              TEXT,
  geography           TEXT,
  company_size        TEXT,
  tam                 BIGINT,
  tam_confidence      INTEGER,

  -- Calendar-invite artifacts. event_description is PLAIN TEXT on purpose: the
  -- same copy has to render into the portal, emails, PDFs and slides, each
  -- wanting different markup. Never store HTML here.
  webinar_title       TEXT,
  event_description   TEXT,
  webinar_date        DATE,
  recording_url       TEXT,
  registration_url    TEXT,
  reference_asset_url TEXT,

  -- Which tabs this client is cleared to appear on. The gate, not a hint:
  -- a client with weak invite-to-registration is never shown on Calendar
  -- Invite even when they are strong proof elsewhere.
  use_on_tabs         TEXT[]      NOT NULL DEFAULT '{}',
  data_flags          TEXT,

  -- Single-webinar funnel
  invites_sent        INTEGER,
  registrations       INTEGER,
  attendees           INTEGER,
  booked_calls        INTEGER,

  -- Campaign totals across every run (what the ROI tab compares against)
  webinars_run        INTEGER,
  total_invites       INTEGER,
  total_registrations INTEGER,
  total_attendees     INTEGER,
  total_booked_calls  INTEGER,

  -- Evidence class. 'Workshop stats database' is tracked per-run measurement;
  -- 'Client interview (self-reported)' is the client's own account. The portal
  -- badges these differently — do not blend them into one number.
  stats_source        TEXT,
  stats_basis         TEXT,

  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tab gating and TAM-nearest matching are the two hot queries.
CREATE INDEX IF NOT EXISTS case_study_clients_use_on_tabs_idx
  ON sales_assets.case_study_clients USING GIN (use_on_tabs);
CREATE INDEX IF NOT EXISTS case_study_clients_tam_idx
  ON sales_assets.case_study_clients (tam) WHERE tam IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_assets.case_study_transcripts (
  id                  BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  airtable_record_id  TEXT        NOT NULL UNIQUE,
  client_name         TEXT,
  company             TEXT,
  -- Soft link: Airtable's link field can be empty or point at a row that has not
  -- synced yet, so this is deliberately not a foreign key.
  client_record_id    TEXT,
  status              TEXT,
  transcript          TEXT,
  video_url           TEXT,
  duration            TEXT,
  speakers            TEXT,
  word_count          INTEGER,
  record_type         TEXT,
  slug                TEXT,
  industry_niche      TEXT,
  headline_result     TEXT,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS case_study_transcripts_client_idx
  ON sales_assets.case_study_transcripts (client_record_id);

CREATE TABLE IF NOT EXISTS sales_assets.case_study_clips (
  id                  BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  airtable_record_id  TEXT        NOT NULL UNIQUE,
  title               TEXT,
  client_name         TEXT,
  client_record_id    TEXT,
  transcript_record_id TEXT,
  video_url           TEXT,
  start_time          TEXT,
  end_time            TEXT,
  duration            TEXT,
  quote               TEXT,
  topic               TEXT,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS case_study_clips_client_idx
  ON sales_assets.case_study_clips (client_record_id);

-- One row recording the last sync, so Settings can show freshness and the last
-- error without scanning the tables.
CREATE TABLE IF NOT EXISTS sales_assets.case_study_sync_state (
  id             BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  last_synced_at TIMESTAMPTZ,
  last_status    TEXT        NOT NULL DEFAULT 'never',   -- never | ok | error
  last_error     TEXT,
  clients        INTEGER     NOT NULL DEFAULT 0,
  transcripts    INTEGER     NOT NULL DEFAULT 0,
  clips          INTEGER     NOT NULL DEFAULT 0,
  images_rehosted INTEGER    NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO sales_assets.case_study_sync_state (last_status)
SELECT 'never'
WHERE NOT EXISTS (SELECT 1 FROM sales_assets.case_study_sync_state);

-- service_role needs explicit grants in the sales_assets schema (see zoom_config).
GRANT ALL ON sales_assets.case_study_clients      TO service_role;
GRANT ALL ON sales_assets.case_study_transcripts  TO service_role;
GRANT ALL ON sales_assets.case_study_clips        TO service_role;
GRANT ALL ON sales_assets.case_study_sync_state   TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales_assets.case_study_clients_id_seq     TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales_assets.case_study_transcripts_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales_assets.case_study_clips_id_seq       TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales_assets.case_study_sync_state_id_seq  TO service_role;

NOTIFY pgrst, 'reload schema';
