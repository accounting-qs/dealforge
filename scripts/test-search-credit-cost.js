// Isolation test — does mixed_companies/search and/or organizations/search
// (v1) consume Apollo credits on this plan?
//
// HOW TO USE:
//   1. Open https://app.apollo.io/#/settings/credits/about → record:
//        Email usage:      ___
//        Enrichment usage: ___
//   2. Run: node scripts/test-search-credit-cost.js
//   3. Refresh the dashboard → record AFTER counts
//
// What this fires (10 calls total, NO people/match):
//   • 5  x  POST /api/v1/mixed_companies/search   (used by enrichLeadsWithCompanyData)
//   • 5  x  POST /v1/organizations/search         (used by preflightCompanyCheck)
//
// Outcomes:
//   • Both deltas == 0  → both endpoints are FREE on this plan. Lead generation
//                         remains zero-credit in the normal flow.
//   • +5 Enrichment     → one of them charges 1 credit/call. We'll narrow it
//                         down by inspecting which 5 ran more recently.
//   • +10 Enrichment    → both charge. Per-job cost ≈ 26 credits (1 preflight
//                         + 25 hydration) on every fresh search + every rerun.

require('dotenv').config();
const APOLLO_KEY = process.env.APOLLO_API_KEY;

const COMPANY_NAMES = [
  'Crosscut Ventures',
  'McNamara Financial Services',
  'Banyan Square Partners',
  'Fika Ventures',
  'Wonder Ventures'
];

const ORG_SEARCH_PAYLOADS = [
  { organization_locations: ['United States'], organization_num_employees_ranges: ['11,50'], per_page: 1, page: 1 },
  { organization_locations: ['United States'], organization_num_employees_ranges: ['51,200'], per_page: 1, page: 1 },
  { organization_locations: ['United States'], organization_num_employees_ranges: ['201,500'], per_page: 1, page: 1 },
  { q_keywords: 'financial services',          organization_num_employees_ranges: ['11,50'], per_page: 1, page: 1 },
  { q_keywords: 'consulting',                  organization_num_employees_ranges: ['11,50'], per_page: 1, page: 1 }
];

async function hit(label, url, body) {
  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify(body)
  });
  let d; try { d = await r.json(); } catch { d = {}; }
  const orgs = (d.organizations || []).length;
  console.log(`  ${label}  HTTP ${r.status}  ${(Date.now()-t0)+'ms'}  orgs=${orgs}`);
}

(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Apollo search-endpoints credit-cost test');
  console.log('  10 calls total: 5 × mixed_companies/search + 5 × organizations/search');
  console.log('  NO people/match calls — pure search-endpoint test.');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('▶ STEP 1: open Apollo dashboard, note BEFORE counts.');
  console.log('  https://app.apollo.io/#/settings/credits/about');
  console.log('  Starting in 8s…');
  await new Promise(r => setTimeout(r, 8000));
  console.log('');

  console.log('▶ Round A — mixed_companies/search (by exact name)');
  for (const name of COMPANY_NAMES) {
    await hit('comp-search', 'https://api.apollo.io/api/v1/mixed_companies/search',
              { q_organization_name: name, per_page: 1, page: 1 });
  }
  console.log('');
  console.log('▶ Round B — organizations/search (v1, used by preflight)');
  for (const payload of ORG_SEARCH_PAYLOADS) {
    await hit('org-search ', 'https://api.apollo.io/v1/organizations/search', payload);
  }
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  10 calls done. NOW refresh the dashboard.');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('Interpretation:');
  console.log('  Enrichment Δ = 0   → both endpoints FREE on this plan. ✅');
  console.log('  Enrichment Δ = 5   → ONE endpoint charges. (Round A or B — check the search history if Apollo exposes it.)');
  console.log('  Enrichment Δ = 10  → BOTH charge 1 credit/call.');
  console.log('  Email Δ should stay 0 either way (no email reveals were requested).');
})();
