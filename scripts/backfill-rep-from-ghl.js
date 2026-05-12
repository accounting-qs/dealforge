// One-shot: backfill sales_assets.jobs.rep_name from GHL for rows where it's NULL.
//
//   For each job with rep_name IS NULL:
//     1. lookupGHLContact(prospect_email)   →  contact.assignedTo
//     2. Look up assignedTo → sales_assets.sales_reps.slug
//     3. PATCH sales_assets.jobs SET rep_name = slug
//
//   Dry-run by default. Pass --apply to actually write.
//
// Prerequisites: .env with SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_KEY),
// GHL_API_KEY, GHL_LOCATION_ID. sales_reps must already be seeded.
//
// Usage:
//   node scripts/backfill-rep-from-ghl.js          # dry run, logs proposals
//   node scripts/backfill-rep-from-ghl.js --apply  # write PATCHes

'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
if (!GHL_API_KEY || !GHL_LOCATION_ID) { console.error('Missing GHL_API_KEY / GHL_LOCATION_ID'); process.exit(1); }

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: 'Bearer ' + SUPABASE_KEY,
  'Accept-Profile': 'sales_assets',
  'Content-Profile': 'sales_assets',
  'Content-Type': 'application/json'
};

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: SB_HEADERS, cache: 'no-store' });
  if (!r.ok) throw new Error(`Supabase GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbPatch(path, body) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'PATCH', headers: { ...SB_HEADERS, Prefer: 'return=minimal' }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Supabase PATCH ${path}: ${r.status} ${await r.text()}`);
}

async function ghlContact(email) {
  const url = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`;
  const r = await fetch(url, {
    headers: { Authorization: 'Bearer ' + GHL_API_KEY, Version: '2021-07-28' },
    signal: AbortSignal.timeout(5000)
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.contact || null;
}

async function ghlOpportunityOwner(contactId) {
  if (!contactId) return null;
  const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${encodeURIComponent(contactId)}`;
  const r = await fetch(url, {
    headers: { Authorization: 'Bearer ' + GHL_API_KEY, Version: '2021-07-28' },
    signal: AbortSignal.timeout(5000)
  });
  if (!r.ok) return null;
  const data = await r.json();
  const opps = Array.isArray(data.opportunities) ? data.opportunities : [];
  if (!opps.length) return null;
  opps.sort((a, b) => new Date(b.updatedAt || b.dateUpdated || 0) - new Date(a.updatedAt || a.dateUpdated || 0));
  const top = opps[0];
  return top.assignedTo || top.assigned_to || top.assigned || null;
}

// Resolve a job to a rep slug. Opportunity owner wins; contact owner is the
// fallback. Returns { ghlUserId, source } or null.
async function resolveRep(email) {
  const c = await ghlContact(email);
  if (!c) return { found: 'no_contact' };
  const oppOwner = await ghlOpportunityOwner(c.id);
  if (oppOwner) return { ghlUserId: oppOwner, source: 'opportunity', contactId: c.id };
  const contactOwner = c.assignedTo || c.assigned_to || c.assigned || null;
  if (contactOwner) return { ghlUserId: contactOwner, source: 'contact', contactId: c.id };
  return { found: 'no_owner', contactId: c.id };
}

(async () => {
  console.log(APPLY ? '▶ APPLY mode — will PATCH job rows' : '▶ DRY-RUN — pass --apply to write');

  // Build ghl_user_id → slug map
  const reps = await sbGet('sales_reps?select=ghl_user_id,slug,active&active=eq.true');
  const ghlToSlug = new Map(reps.map(r => [r.ghl_user_id, r.slug]));
  console.log(`  sales_reps loaded: ${reps.length} active`);
  if (!reps.length) { console.error('No active sales_reps rows — run the migration first'); process.exit(1); }

  // Find candidate jobs
  const jobs = await sbGet('jobs?select=id,prospect_email&rep_name=is.null&order=created_at.desc&limit=500');
  console.log(`  candidate jobs (rep_name IS NULL): ${jobs.length}`);
  if (!jobs.length) { console.log('Nothing to backfill.'); return; }

  const counters = { filled_opp: 0, filled_contact: 0, no_contact: 0, no_owner: 0, unknown_user: 0, errors: 0 };
  for (const job of jobs) {
    try {
      const r = await resolveRep(job.prospect_email);
      if (r.found === 'no_contact') { counters.no_contact++; continue; }
      if (r.found === 'no_owner')   { counters.no_owner++;   continue; }
      const slug = ghlToSlug.get(r.ghlUserId);
      if (!slug) {
        counters.unknown_user++;
        console.warn(`  ! ${job.prospect_email}: GHL user ${r.ghlUserId} (${r.source}) not in sales_reps`);
        continue;
      }
      console.log(`  ${APPLY ? '→' : '·'} ${job.prospect_email}  → ${slug}  [${r.source}]  (job ${job.id.slice(0,8)})`);
      if (APPLY) {
        await sbPatch(`jobs?id=eq.${job.id}`, { rep_name: slug, updated_at: new Date().toISOString() });
      }
      if (r.source === 'opportunity') counters.filled_opp++;
      else                            counters.filled_contact++;
    } catch(e) {
      counters.errors++;
      console.warn(`  ! ${job.prospect_email}: ${e.message}`);
    }
  }

  console.log('\nSummary:');
  Object.entries(counters).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(APPLY ? '\nDone.' : '\nNo writes performed. Re-run with --apply to commit.');
})();
