// Standalone smoke test for the tam_estimate task logic.
// Mirrors handleTamEstimate() in server.js WITHOUT starting the server/worker.
// Exercises the real Anthropic planner + real Apollo (suggestIndustries + count
// probes) on a sample ICP.
//
// Run:            node scripts/test-tam-estimate.js
// Real job ICP:   TAM_TEST_ICP='{"apollo_titles":[...],...}' node scripts/test-tam-estimate.js
// Requires .env with ANTHROPIC_API_KEY + APOLLO_API_KEY.
//
// Keep the prompt + adjacent-industry logic + guards in sync with server.js.

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const SAMPLE_ICP = process.env.TAM_TEST_ICP ? JSON.parse(process.env.TAM_TEST_ICP) : {
  target_audience_type: 'b2b',
  apollo_titles: ['Chief Marketing Officer', 'VP Marketing'],
  apollo_geography: ['United States'],
  apollo_employee_ranges: ['51,200', '201,500'],
  apollo_keyword: 'software',
  person_seniorities: [],
  role: 'Marketing leaders at mid-market SaaS'
};

const TAM_PLANNER_SYSTEM = `You are a fast B2B TAM query planner for a lead-generation sales demo.
You are given an ICP (ideal customer profile) already normalized into Apollo.io search fields, and a list of ADJACENT INDUSTRIES (real Apollo industry values near the buyer's industry).
The current system undercounts the market ~10-20x because it queries ONE narrow set of exact job titles WITH a single narrow industry.
Your job: propose 4-6 BROAD but believable Apollo "slices" that capture the real addressable market, plus one narrow "floor" slice that mirrors the exact-titles query.

BROADENING STRATEGY — broaden the ROLE, keep the market:
1. WIDEN THE TITLES aggressively — this is your main lever. Include the seed titles PLUS every adjacent decision-maker title (the same function under different names, and neighbouring functions who also buy). A large union of real titles is the most reliable broadener. Aim for 12-20 titles on the broad slices.
2. KEEP THE INDUSTRY, but broaden it to the ADJACENT INDUSTRIES provided (do NOT drop the industry entirely, and do NOT keep only the single seed industry). Put the adjacent industries in q_organization_keyword_tags on the broad slices. This keeps the TAM to "their kind of client".
3. Keep geography and company size as given (wide).

VALID FIELDS ONLY (anything else is ignored or returns 0):
- person_titles: array of real job titles (2-4 words each).
- person_seniorities: array. VALID VALUES ONLY: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern.
- person_department_or_subdepartments: array. VALID VALUES ONLY (exact snake_case): c_suite, product_management, engineering_technical, design, education, finance, human_resources, information_technology, legal, marketing, medical_health, operations, sales, consulting, business_development, support, administrative, accounting, arts_and_design, entrepreneurship, media_communications. Map L&D / training / talent to human_resources. If unsure, OMIT department and use a wide title union.
- organization_locations, organization_num_employees_ranges, q_organization_keyword_tags (adjacent industries), revenue_range.

HARD RULES:
- Every slice MUST contain person_titles OR person_department_or_subdepartments. NEVER seniority-only.
- Include exactly ONE slice labelled as the narrow exact-titles floor (seed titles + single seed industry).
- Every OTHER (broad) slice keeps an industry filter set to the ADJACENT INDUSTRIES provided.
- union_uplift: 1.0-1.3.

Return ONLY this JSON (no prose, no fences):
{"slices":[{"label":"Exact titles (narrow floor)","payload":{...}},{"label":"Wide title union, adjacent industries","payload":{...}}],"confidence":1-10,"reasoning":"one sentence","union_uplift":1.0}`;

const VALID_DEPARTMENTS = new Set(['c_suite','product_management','engineering_technical','design','education','finance','human_resources','information_technology','legal','marketing','medical_health','operations','sales','consulting','business_development','support','administrative','accounting','arts_and_design','entrepreneurship','media_communications']);
const DEPARTMENT_ALIASES = { 'learning and development':'human_resources','learning & development':'human_resources','l&d':'human_resources','training':'human_resources','talent':'human_resources','talent development':'human_resources','people':'human_resources','hr':'human_resources','human resources':'human_resources','organizational development':'human_resources','it':'information_technology','engineering':'engineering_technical','product':'product_management','medical':'medical_health','healthcare':'medical_health' };
function normalizeDepartments(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const raw of arr) {
    const s = String(raw || '').trim().toLowerCase(); if (!s) continue;
    const slug = VALID_DEPARTMENTS.has(s) ? s : (DEPARTMENT_ALIASES[s] || DEPARTMENT_ALIASES[s.replace(/_/g,' ')] || null);
    if (slug && VALID_DEPARTMENTS.has(slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

function extractJson(raw) {
  if (!raw) return null;
  let s = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < 0) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const KEY = process.env.APOLLO_API_KEY;
async function apolloPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  if (!r.ok) return null;
  return r.json();
}
async function suggestIndustries(q) {
  if (!KEY || !q) return [];
  const d = await apolloPost('https://api.apollo.io/v1/organizations/search', { q_organization_keyword_tags: [q], per_page: 25 });
  if (!d) return [];
  const counts = new Map();
  const bump = s => { if (!s) return; const v = String(s).trim(); if (v) counts.set(v, (counts.get(v) || 0) + 1); };
  (d.organizations || []).forEach(o => { bump(o.industry); if (Array.isArray(o.industries)) o.industries.forEach(bump); });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s]) => s);
}
async function apolloCount(payload) {
  const d = await apolloPost('https://api.apollo.io/api/v1/mixed_people/api_search', { ...payload, per_page: 1 });
  return d ? (Number(d.total_entries) || 0) : 0;
}

(async () => {
  console.log('ICP titles:', JSON.stringify(SAMPLE_ICP.apollo_titles), '· kw:', SAMPLE_ICP.apollo_keyword, '·', SAMPLE_ICP.apollo_geography, SAMPLE_ICP.apollo_employee_ranges);

  const seedIndustry = (SAMPLE_ICP.apollo_keyword || SAMPLE_ICP.industry || '').trim() || null;
  let adjacentIndustries = [];
  if (seedIndustry) {
    const live = await suggestIndustries(seedIndustry);
    adjacentIndustries = [seedIndustry, ...live].map(s => String(s || '').trim()).filter(Boolean)
      .filter((s, i, a) => a.findIndex(x => x.toLowerCase() === s.toLowerCase()) === i).slice(0, 6);
    console.log('Adjacent industries (Apollo taxonomy):', JSON.stringify(adjacentIndustries));
  }
  const allowedInd = new Set(adjacentIndustries.map(s => s.toLowerCase()));

  let plan = null;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const up = `ICP (Apollo fields):\n${JSON.stringify(SAMPLE_ICP, null, 2)}\n\nSEED INDUSTRY: ${JSON.stringify(seedIndustry)}\nADJACENT INDUSTRIES: ${JSON.stringify(adjacentIndustries)}`;
    const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1500, temperature: 0, system: TAM_PLANNER_SYSTEM, messages: [{ role: 'user', content: up }] });
    plan = extractJson(msg.content[0].text);
    console.log('\nPlanner:', plan?.slices?.length, 'slices · confidence', plan?.confidence, '· uplift', plan?.union_uplift);
    console.log('reasoning:', plan?.reasoning);
  } catch (e) { console.warn('\nPlanner FAILED:', e.message); }

  let sliceDefs = (plan?.slices || []).filter(s => s?.payload).map(s => {
    const p = { ...s.payload };
    if (p.person_department_or_subdepartments !== undefined) {
      const d = normalizeDepartments(p.person_department_or_subdepartments);
      if (d.length) p.person_department_or_subdepartments = d; else delete p.person_department_or_subdepartments;
    }
    return { label: s.label, payload: p };
  }).filter(s => {
    const hasT = Array.isArray(s.payload.person_titles) && s.payload.person_titles.length;
    const hasD = Array.isArray(s.payload.person_department_or_subdepartments) && s.payload.person_department_or_subdepartments.length;
    if (!hasT && !hasD) { console.warn('  (dropping unbounded slice:', s.label + ')'); return false; }
    return true;
  }).map(s => {
    const isFloor = /floor|exact|narrow/i.test(s.label);
    if (isFloor) { if (seedIndustry) s.payload.q_organization_keyword_tags = [seedIndustry]; }
    else if (adjacentIndustries.length) {
      const cur = Array.isArray(s.payload.q_organization_keyword_tags) ? s.payload.q_organization_keyword_tags.filter(v => allowedInd.has(String(v).trim().toLowerCase())) : [];
      s.payload.q_organization_keyword_tags = cur.length ? cur : adjacentIndustries.slice();
    }
    return s;
  });

  console.log('\nProbing Apollo for each slice:');
  const slices = [];
  for (const s of sliceDefs) {
    const total = await apolloCount(s.payload);
    slices.push({ label: s.label, total });
    console.log(`  • ${s.label}: ${total.toLocaleString()}   [ind: ${JSON.stringify(s.payload.q_organization_keyword_tags || 'none')}]`);
  }

  const floorSlice = slices.find(s => /floor|exact|narrow/i.test(s.label));
  const tamFloor = floorSlice ? floorSlice.total : 0;
  const largest = Math.max(0, ...slices.map(s => s.total));
  let uplift = Number(plan?.union_uplift); if (!Number.isFinite(uplift)) uplift = 1.0;
  uplift = Math.min(1.5, Math.max(1.0, uplift));
  let tam = Math.round(largest * uplift);
  if (tamFloor > tam) tam = tamFloor;

  console.log('\n─────────────────────────────');
  console.log('TAM floor (narrow):', tamFloor.toLocaleString());
  console.log('TAM headline      :', tam.toLocaleString(), `(largest ${largest.toLocaleString()} × ${uplift})`);
  console.log('Broadening factor :', tamFloor ? (tam / tamFloor).toFixed(1) + '×' : 'n/a');
})();
