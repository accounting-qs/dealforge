-- ────────────────────────────────────────────────────────────────────────────
-- sales_assets.sales_reps  —  GHL user → rep slug mapping
-- ────────────────────────────────────────────────────────────────────────────
-- Apply in the Supabase SQL editor against project lcryrllxityssyamcvst.
-- Run sections 1–4 in order. Section 5 is the optional GHL backfill plan.
--
-- Schema decision: the new table maps a GHL "assignedTo" user ID to one of the
-- canonical rep slugs the app already uses ('melissa' | 'ryan' | 'armando').
-- Jobs continue to store the slug in sales_assets.jobs.rep_name — no new
-- column on jobs. The join key is sales_reps.slug = jobs.rep_name.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Pre-flight audit ──────────────────────────────────────────────────────
-- Eyeball the rep_name distribution. Expected values: melissa, ryan, armando,
-- NULL. If anything else appears, normalize it in section 2 before seeding.

select rep_name, count(*) as jobs
from   sales_assets.jobs
group  by rep_name
order  by jobs desc;


-- 2. Normalize drift (run only if section 1 surfaced unexpected values) ────
-- Defensive: any "Melissa F." / "ryan@…" / mixed-case variants get folded
-- back onto the canonical slug.

-- update sales_assets.jobs set rep_name = 'melissa' where lower(rep_name) like 'melissa%';
-- update sales_assets.jobs set rep_name = 'ryan'    where lower(rep_name) like 'ryan%';
-- update sales_assets.jobs set rep_name = 'armando' where lower(rep_name) like 'armando%';


-- 3. Create the sales_reps table ────────────────────────────────────────────

create table if not exists sales_assets.sales_reps (
  ghl_user_id   text primary key,
  slug          text not null unique,
  display_name  text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists sales_reps_slug_active_idx
  on sales_assets.sales_reps (slug) where active;

-- updated_at trigger (keeps the audit honest if anyone manually edits a row)
create or replace function sales_assets.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists sales_reps_touch_updated_at on sales_assets.sales_reps;
create trigger sales_reps_touch_updated_at
  before update on sales_assets.sales_reps
  for each row execute function sales_assets.touch_updated_at();


-- 4. Seed the three known reps ─────────────────────────────────────────────
-- Replace the <ghl_user_id_*> placeholders with real values from GHL.
-- Easiest source: GHL → Settings → My Staff. The user-detail URL contains the
-- ID, or call GET https://services.leadconnectorhq.com/users/?locationId=…
-- with the existing GHL_API_KEY. ON CONFLICT keeps this re-runnable.

insert into sales_assets.sales_reps (ghl_user_id, slug, display_name) values
  ('<ghl_user_id_melissa>', 'melissa', 'Melissa F.'),
  ('<ghl_user_id_ryan>',    'ryan',    'Ryan Matsumori'),
  ('<ghl_user_id_armando>', 'armando', 'Armando')
on conflict (ghl_user_id) do update
  set slug         = excluded.slug,
      display_name = excluded.display_name,
      active       = true;


-- 5. Orphan check — must return 0 rows after seeding ───────────────────────
-- Any existing job whose rep_name doesn't match a sales_reps.slug is an
-- orphan and would render as "unknown rep" in the UI.

select j.id, j.rep_name, j.prospect_email
from   sales_assets.jobs j
left   join sales_assets.sales_reps r on r.slug = j.rep_name
where  j.rep_name is not null and r.slug is null;


-- 6. (Optional) one-time backfill for jobs whose rep_name is NULL ──────────
-- These pre-date GHL auto-assignment. Best run via scripts/backfill-rep-from-ghl.js
-- which uses lookupGHLContact() → contact.assignedTo → sales_reps.slug.
-- Pure-SQL alternative: leave them NULL and let the rep set them from the
-- inline dashboard dropdown (Part 2 UI).
