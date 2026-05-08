// Apollo people/match credit-cost test — 5 production jobs × 25 matches = 125 calls.
//
// HOW TO USE:
//   1. https://app.apollo.io/#/settings/credits/about → record BEFORE counts:
//        Email usage:      ___
//        Enrichment usage: ___
//   2. Run: node scripts/test-credit-cost.js
//   3. Refresh the dashboard → record AFTER counts
//   4. Delta == credit cost across 125 matches.
//
// Per-record fields measured: full last_name, linkedin_url, email, photo_url.
// No reveal flags set.

require('dotenv').config();
const APOLLO_KEY = process.env.APOLLO_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const JOB_IDS = [
  'cd802249-1a88-4883-9c4c-e4955f9aad2e', // Noblecapitalmarkets
  '6c714463-6e3a-4efb-8396-542147b3fab7', // M-Fund VC
  '1f982c7c-8b10-4147-8eeb-1e36495a363e', // Outlook
  '9dda3185-4c0f-4ca6-819d-3d34ed5b2821', // tekrisq
  'bb47c13f-f1e9-4f53-b0de-db1fb7df6a30'  // eBillity
];

async function getJob(jobId) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/jobs?id=eq.' + jobId + '&select=id,prospect_company,extracted_data&limit=1', {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Accept-Profile': 'sales_assets' }
  });
  const rows = await r.json();
  return rows[0];
}

async function searchPeople(icp) {
  const payload = {
    person_titles: icp.apollo_titles || [],
    organization_locations: icp.apollo_geography || [],
    organization_num_employees_ranges: icp.apollo_employee_ranges || [],
    person_seniorities: icp.person_seniorities || [],
    per_page: 50, page: 1
  };
  if (icp.apollo_keyword) payload.q_organization_keyword_tags = [icp.apollo_keyword];
  Object.keys(payload).forEach(k => {
    if (Array.isArray(payload[k]) && payload[k].length === 0) delete payload[k];
  });
  const r = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify(payload)
  });
  const d = await r.json();
  return d.people || [];
}

async function matchById(id) {
  const r = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify({ id })
  });
  return (await r.json()).person || {};
}

(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Apollo people/match credit-cost test');
  console.log('  5 jobs × 25 matches = 125 enrichment calls');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('▶ STEP 1: Note BEFORE balance on dashboard.');
  console.log('  https://app.apollo.io/#/settings/credits/about');
  console.log('  Wait 8 seconds…');
  await new Promise(r => setTimeout(r, 8000));
  console.log('');

  const totals = { matched: 0, last_name: 0, linkedin_url: 0, email: 0, photo_url: 0, phone: 0, headline: 0 };
  const jobReports = [];

  for (let i = 0; i < JOB_IDS.length; i++) {
    const job = await getJob(JOB_IDS[i]);
    if (!job) { console.log(`  job ${JOB_IDS[i]} not found — skip`); continue; }
    const icp = job.extracted_data?.icp || {};
    console.log(`▶ JOB ${i+1}/5: ${job.prospect_company || job.id.slice(0,8)}`);
    console.log(`  titles: ${(icp.apollo_titles || []).slice(0,3).join(', ')}`);

    const people = await searchPeople(icp);
    // dedupe by company, take 25
    const seen = new Set(); const ids = [];
    for (const p of people) {
      const c = (p.organization?.name || '').toLowerCase().trim();
      if (!c || seen.has(c)) continue;
      seen.add(c);
      if (p.id) ids.push(p.id);
      if (ids.length >= 25) break;
    }
    console.log(`  searched ${people.length} → ${ids.length} unique-company ids`);

    const job_totals = { matched: 0, last_name: 0, linkedin_url: 0, email: 0, photo_url: 0, phone: 0, headline: 0 };
    for (const id of ids) {
      const p = await matchById(id);
      if (p && (p.first_name || p.last_name)) {
        job_totals.matched++; totals.matched++;
        if (p.last_name)    { job_totals.last_name++;    totals.last_name++;    }
        if (p.linkedin_url) { job_totals.linkedin_url++; totals.linkedin_url++; }
        if (p.email)        { job_totals.email++;        totals.email++;        }
        if (p.photo_url)    { job_totals.photo_url++;    totals.photo_url++;    }
        if (p.headline)     { job_totals.headline++;     totals.headline++;     }
        if (p.phone || (Array.isArray(p.phone_numbers) && p.phone_numbers.length)) {
          job_totals.phone++; totals.phone++;
        }
      }
    }
    console.log(`  fill: name=${job_totals.last_name}/${ids.length} li=${job_totals.linkedin_url}/${ids.length} email=${job_totals.email}/${ids.length} photo=${job_totals.photo_url}/${ids.length}`);
    jobReports.push({ company: job.prospect_company, ids: ids.length, ...job_totals });
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  AGGREGATE  —  total people/match calls: ' + totals.matched);
  console.log('═══════════════════════════════════════════════════════');
  ['last_name', 'linkedin_url', 'email', 'photo_url', 'headline', 'phone'].forEach(f => {
    console.log(`  ${f.padEnd(15)} ${totals[f]}/${totals.matched}`);
  });
  console.log('');
  console.log('▶ STEP 2: Refresh dashboard, record AFTER balance.');
  console.log('  https://app.apollo.io/#/settings/credits/about');
  console.log('');
  console.log('Expected delta interpretation:');
  console.log(`  Email +0,    Enrichment +0    → MATCH IS FREE.  Wire it in.`);
  console.log(`  Email +${totals.email},  Enrichment +0   → emails counted as 1/each.`);
  console.log(`  Email +0,    Enrichment +${totals.matched} → matches counted as 1/each.`);
  console.log(`  Email +${totals.email},  Enrichment +${totals.matched}  → both counted.`);
})();
