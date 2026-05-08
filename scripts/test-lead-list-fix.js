// Smoke test for the lead_list pipeline changes — runs the production logic
// against the M-Fund VC ICP and prints fill rates + a sample. Inlines the helpers
// that were added to server.js so we don't trigger its module-level worker loops.
//
// Tests:
//   1. enrichLeadsWithCompanyData — populates website + company linkedin_url
//   2. unique-company dedup
//   3. Size fallback from ICP employee ranges
require('dotenv').config();

const APOLLO_KEY = process.env.APOLLO_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Helpers (mirrors of what server.js exports internally) ────────────────────
function fmtEmp(n) {
  if (!n) return '';
  if (n <= 10) return `${n} emp`;
  if (n <= 200) return `${Math.round(n/10)*10} emp`;
  if (n <= 1000) return `~${Math.round(n/100)*100} emp`;
  return `${Math.round(n/1000)}K+ emp`;
}

function formatEmployeeRangeBand(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return '';
  const bounds = ranges
    .map(r => String(r).split(',').map(n => parseInt(n, 10)))
    .filter(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi));
  if (!bounds.length) return '';
  const lo = Math.min(...bounds.map(b => b[0]));
  const hi = Math.max(...bounds.map(b => b[1]));
  return lo === hi ? `${lo} emp` : `${lo}–${hi} emp`;
}

function normalizePerson(p) {
  const org = p.organization || {};
  const name = p.name
    || (p.first_name && (p.last_name || p.last_name_obfuscated)
        ? `${p.first_name} ${p.last_name || p.last_name_obfuscated}`.trim()
        : (p.first_name || null));
  const company = p.organization_name || org.name || null;
  const website = p.website_url || org.website_url || org.primary_domain || null;
  const employeeCount = p.organization_num_employees || org.estimated_num_employees || null;
  return {
    name, title: p.title, company,
    company_size: fmtEmp(employeeCount),
    website,
    linkedin_url: p.linkedin_url || p.linkedin_url_obfuscated || null
  };
}

async function enrichLeadsWithCompanyData(leads) {
  if (!leads.length) return leads;
  const uniqueCompanies = [...new Set(leads.map(l => l.company).filter(Boolean))];
  const orgByName = new Map();
  const CONCURRENCY = 5;

  for (let i = 0; i < uniqueCompanies.length; i += CONCURRENCY) {
    const batch = uniqueCompanies.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (name) => {
      try {
        const res = await fetch('https://api.apollo.io/api/v1/mixed_companies/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_KEY },
          body: JSON.stringify({ q_organization_name: name, per_page: 1, page: 1 }),
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) return;
        const d = await res.json();
        const o = d.organizations?.[0];
        if (!o) return;
        const a = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const b = (o.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!a || !b || (!b.includes(a) && !a.includes(b))) return;
        orgByName.set(name, {
          website: o.website_url || (o.primary_domain ? 'https://' + o.primary_domain : null),
          company_linkedin_url: o.linkedin_url || null
        });
      } catch (e) { /* per-company failures non-fatal */ }
    }));
  }

  let hits = 0;
  leads.forEach(l => {
    const o = orgByName.get(l.company);
    if (!o) return;
    if (!l.website) l.website = o.website;
    if (!l.linkedin_url) l.linkedin_url = o.company_linkedin_url;
    hits++;
  });
  console.log(`[hydration] ${hits}/${leads.length} leads enriched (${orgByName.size}/${uniqueCompanies.length} companies matched)`);
  return leads;
}

// ── Test ─────────────────────────────────────────────────────────────────────
(async () => {
  const jobId = '6c714463-6e3a-4efb-8396-542147b3fab7';
  const r = await fetch(SUPABASE_URL + '/rest/v1/jobs?id=eq.' + jobId + '&select=extracted_data', {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Accept-Profile': 'sales_assets' }
  });
  const [{ extracted_data }] = await r.json();
  const icp = extracted_data.icp;

  console.log('=== M-Fund VC ICP ===');
  console.log(`  titles: ${icp.apollo_titles.join(', ')}`);
  console.log(`  geo: ${icp.apollo_geography.join(', ')}`);
  console.log(`  employee ranges: ${icp.apollo_employee_ranges.join(', ')}`);
  console.log(`  keyword: ${icp.apollo_keyword}`);
  console.log('');

  const payload = {
    person_titles: icp.apollo_titles,
    organization_locations: icp.apollo_geography,
    organization_num_employees_ranges: icp.apollo_employee_ranges,
    person_seniorities: icp.person_seniorities,
    q_organization_keyword_tags: icp.apollo_keyword ? [icp.apollo_keyword] : undefined,
    per_page: 50, page: 1
  };

  console.log('=== Running Apollo people search ===');
  const t0 = Date.now();
  const psRes = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify(payload)
  });
  const psData = await psRes.json();
  const rawLeads = (psData.people || []).map(normalizePerson).filter(l => l.name && l.title && l.company);
  console.log(`  ${rawLeads.length} people, TAM ${psData.total_entries}, took ${((Date.now()-t0)/1000).toFixed(1)}s`);

  console.log('');
  console.log('=== Hydrating with mixed_companies/search ===');
  await enrichLeadsWithCompanyData(rawLeads);

  // Dedup
  const seen = new Set(); const dedup = [];
  for (const l of rawLeads) {
    const k = (l.company || '').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k); dedup.push(l);
    if (dedup.length >= 25) break;
  }
  const sizeFallback = formatEmployeeRangeBand(icp.apollo_employee_ranges);
  if (sizeFallback) dedup.forEach(l => { if (!l.company_size) l.company_size = sizeFallback; });

  console.log(`[dedup] ${rawLeads.length} → ${dedup.length} unique-company leads (size fallback "${sizeFallback}")`);
  console.log('');
  console.log('=== Fill rates ===');
  ['name','title','company','company_size','website','linkedin_url'].forEach(f => {
    const filled = dedup.filter(l => l[f]).length;
    console.log(`  ${f.padEnd(15)} ${filled}/${dedup.length}`);
  });
  console.log('');
  console.log('=== Sample (first 3) ===');
  dedup.slice(0, 3).forEach((l, i) => {
    console.log(`  #${i+1} ${l.name} | ${l.title} | ${l.company} | ${l.company_size} | ${l.website || '—'} | ${l.linkedin_url || '—'}`);
  });
})();
