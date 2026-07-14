// Standalone smoke test for the tam_estimate task logic.
// Mirrors handleTamEstimate() in server.js WITHOUT starting the server/worker,
// so it never competes with the live worker for prod tasks. Exercises the real
// Anthropic planner + real Apollo count probes on a sample ICP.
//
// Run:            node scripts/test-tam-estimate.js
// Real job ICP:   TAM_TEST_ICP='{"apollo_titles":[...],...}' node scripts/test-tam-estimate.js
// Requires .env with ANTHROPIC_API_KEY + APOLLO_API_KEY.
//
// Keep this prompt + guards in sync with server.js (TAM_PLANNER_SYSTEM,
// normalizeDepartments, the unbounded-slice filter, and the aggregation).

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
You are given an ICP (ideal customer profile) already normalized into Apollo.io search fields.
The current system undercounts the market ~10-20x because it queries ONE narrow set of exact job titles WITH a narrow industry keyword.
Your job: propose 4-6 BROAD but believable Apollo "slices" that together capture the real TOTAL addressable market (what they COULD target, not just their current niche), plus one narrow "floor" slice that mirrors the exact-titles query.

THE TWO BIGGEST LEVERS (use them):
1. DROP the industry keyword on the broad slices. The industry keyword (q_organization_keyword_tags) is usually the single biggest under-counter — the real TAM for a role spans many industries, not just the seed one. At least ONE broad slice MUST have NO q_organization_keyword_tags at all. Others may LOOSEN it to adjacent industries (e.g. pharmaceuticals -> also biotech, life sciences, healthcare, medical devices).
2. WIDEN the titles. Include the seed titles PLUS adjacent decision-maker titles (the same function under different names, and neighbouring functions who also buy). A big union of real titles is your most reliable broadener.

VALID FIELDS ONLY (anything else is ignored or returns 0):
- person_titles: array of real job titles (2-4 words each).
- person_seniorities: array. VALID VALUES ONLY: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern.
- person_department_or_subdepartments: array. VALID VALUES ONLY (exact snake_case): c_suite, product_management, engineering_technical, design, education, finance, human_resources, information_technology, legal, marketing, medical_health, operations, sales, consulting, business_development, support, administrative, accounting, arts_and_design, entrepreneurship, media_communications. There is NO "learning_and_development" department in Apollo — map L&D / training / talent to human_resources. If unsure, OMIT department and use a wide title union instead.
- organization_locations: array of country/region names.
- organization_num_employees_ranges: array of codes like "51,200","201,500","1001,10000".
- q_organization_keyword_tags: array of short industry phrases, OR-ed (DROP on the broad slices per lever 1).
- revenue_range: {min,max} in USD, or omit.

HARD RULES:
- Every slice MUST contain person_titles OR person_department_or_subdepartments (or both). NEVER a slice with only person_seniorities — that matches millions of people and is not believable.
- When you use person_department_or_subdepartments, pair it with person_seniorities to keep it to decision-makers.
- Include exactly ONE slice labelled as the narrow exact-titles floor (seed titles + the seed industry keyword) — this anchors the baseline.
- Include at least ONE broad slice with NO industry keyword.
- Do NOT invent numbers. Prefer broad+believable over precise.
- union_uplift: a small multiplier between 1.0 and 1.3 approximating the true cross-slice union beyond the single largest slice. Use 1.0 if unsure.

Return ONLY this JSON (no prose, no markdown fences):
{
  "slices": [
    { "label": "Exact titles (narrow floor)", "payload": { "person_titles": ["..."], "q_organization_keyword_tags": ["..."], "organization_locations": ["..."], "organization_num_employees_ranges": ["..."] } },
    { "label": "Wide title union, no industry", "payload": { "person_titles": ["...","...","..."], "organization_locations": ["..."], "organization_num_employees_ranges": ["..."] } },
    { "label": "Function + seniority, no industry", "payload": { "person_seniorities": ["vp","head","director"], "person_department_or_subdepartments": ["human_resources"], "organization_locations": ["..."], "organization_num_employees_ranges": ["..."] } }
  ],
  "confidence": 1-10,
  "reasoning": "one sentence",
  "union_uplift": 1.0
}`;

const VALID_DEPARTMENTS = new Set(['c_suite','product_management','engineering_technical','design','education','finance','human_resources','information_technology','legal','marketing','medical_health','operations','sales','consulting','business_development','support','administrative','accounting','arts_and_design','entrepreneurship','media_communications']);
const DEPARTMENT_ALIASES = { 'learning and development':'human_resources','learning & development':'human_resources','l&d':'human_resources','training':'human_resources','talent':'human_resources','talent development':'human_resources','people':'human_resources','hr':'human_resources','human resources':'human_resources','organizational development':'human_resources','it':'information_technology','tech':'information_technology','engineering':'engineering_technical','product':'product_management','biz dev':'business_development','bizdev':'business_development','medical':'medical_health','healthcare':'medical_health','comms':'media_communications','communications':'media_communications','marketing communications':'marketing' };
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

async function apolloCount(payload) {
  const KEY = process.env.APOLLO_API_KEY;
  if (!KEY) return 0;
  try {
    const body = { ...payload, per_page: 1, page: 1 };
    delete body.q_keywords;
    const res = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) { console.error('  Apollo HTTP', res.status, await res.text().catch(() => '')); return 0; }
    const data = await res.json();
    return Number(data.total_entries) || 0;
  } catch (e) { console.error('  Apollo exception:', e.message); return 0; }
}

(async () => {
  console.log('ICP:', JSON.stringify(SAMPLE_ICP.apollo_titles), SAMPLE_ICP.apollo_geography, SAMPLE_ICP.apollo_employee_ranges, '· kw:', SAMPLE_ICP.apollo_keyword);

  let plan = null;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1500, temperature: 0,
      system: TAM_PLANNER_SYSTEM,
      messages: [{ role: 'user', content: `ICP (Apollo fields):\n${JSON.stringify(SAMPLE_ICP, null, 2)}` }]
    });
    plan = extractJson(msg.content[0].text);
    console.log('\nPlanner returned', plan?.slices?.length, 'slices · confidence', plan?.confidence, '· uplift', plan?.union_uplift);
    console.log('reasoning:', plan?.reasoning);
  } catch (e) {
    console.warn('\nPlanner FAILED (' + (e.status || '') + '):', e.message, '\n→ falling back to deterministic broad slice');
  }

  let sliceDefs;
  if (plan?.slices?.length) {
    sliceDefs = plan.slices.filter(s => s?.payload).map(s => {
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
    });
  } else {
    sliceDefs = [{ label: 'Broad (deterministic)', payload: {
      person_titles: SAMPLE_ICP.apollo_titles,
      organization_locations: SAMPLE_ICP.apollo_geography,
      organization_num_employees_ranges: SAMPLE_ICP.apollo_employee_ranges
    }}];
  }

  console.log('\nProbing Apollo for each slice:');
  const slices = [];
  for (const s of sliceDefs) {
    const total = await apolloCount(s.payload);
    slices.push({ label: s.label, total });
    console.log(`  • ${s.label}: ${total.toLocaleString()}`);
    console.log('      payload:', JSON.stringify(s.payload));
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
  console.log(tam >= tamFloor && tam > 0 ? '✅ TAM is grounded and >= floor' : '⚠️ check: TAM not greater than floor');
})();
