// Throwaway verification for the extracted-filter taxonomy validation.
// Mirrors server.js helpers (fetchTitleTags + pickCanonical + the title leg of
// validateExtractedFilters) because server.js isn't require-able. Makes real,
// FREE Apollo calls (no credits, no AI). Run: node scripts/test-filter-validation.js
const fs = require('fs');
const path = require('path');

// Load APOLLO_API_KEY from .env (manual parse — no dotenv dependency needed).
const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const APOLLO_KEY = (env.match(/APOLLO_API_KEY=(.+)/) || [])[1]?.trim().replace(/^["']|["']$/g, '');
if (!APOLLO_KEY) { console.error('No APOLLO_API_KEY in .env'); process.exit(1); }

// ── mirror of server.js normalizeToken ──
const normalizeToken = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ── mirror of server.js fetchTitleTags ──
async function fetchTitleTags(q) {
  if (!q) return [];
  try {
    const url = 'https://app.apollo.io/api/v1/tags/search?q_tag_fuzzy_name='
      + encodeURIComponent(q) + '&kind=person_title&display_mode=fuzzy_select_mode';
    const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json', 'x-api-key': APOLLO_KEY }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.tags || []).map(t => ({
      display_name: String(t.display_name || '').trim(),
      cleaned_name: String(t.cleaned_name || '').trim(),
      num_people: Number(t.num_people) || 0,
      score: Number(t.score) || 0
    })).filter(t => t.display_name || t.cleaned_name);
  } catch (e) { console.warn('[fetchTitleTags]', e.message); return []; }
}

// ── mirror of server.js pickCanonical ──
function pickCanonical(original, candidates, floor = 0) {
  const normOrig = normalizeToken(original);
  if (!normOrig) return null;
  const named = (candidates || []).map(c => ({ name: String(c.name || '').trim(), num_people: c.num_people, score: c.score || 0 })).filter(c => c.name);
  const exact = named.find(c => normalizeToken(c.name) === normOrig);
  if (exact) return exact.name;
  const origTokens = new Set(normOrig.split(' ').filter(Boolean));
  let best = null, bestKey = [-1, -1, -1];
  for (const c of named) {
    if (!(c.num_people >= floor)) continue;
    const tagTokens = normalizeToken(c.name).split(' ').filter(Boolean);
    let overlap = 0;
    for (const tok of tagTokens) if (origTokens.has(tok)) overlap++;
    const ratio = overlap / origTokens.size;
    if (overlap < 1 || (ratio < 0.5 && overlap !== origTokens.size)) continue;
    const key = [overlap, c.score, c.num_people === Infinity ? Number.MAX_SAFE_INTEGER : c.num_people];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1]) || (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] > bestKey[2])) { best = c.name; bestKey = key; }
  }
  return best;
}

const TITLE_POPULATION_FLOOR = 1000;

// mirror of server.js splitTitleParts
function splitTitleParts(s) {
  return String(s || '').split(/\s*(?:,|\/|\||;|&|\band\b)\s*/i).map(p => p.trim()).filter(p => p.length > 1);
}

async function validateTitles(titles) {
  // Flatten to atomic parts (one search per part), preserving first-seen order.
  const parts = [], partSeen = new Set();
  for (const t of titles) for (const p of splitTitleParts(t)) {
    const k = normalizeToken(p); if (k && !partSeen.has(k)) { partSeen.add(k); parts.push(p); }
  }
  const cand = await Promise.all(parts.map(async t => (await fetchTitleTags(t)).map(x => ({ name: x.display_name || x.cleaned_name, num_people: x.num_people, score: x.score }))));
  const out = [], seen = new Set(), snapped = {}, unverified = [];
  parts.forEach((orig, i) => {
    const canon = pickCanonical(orig, cand[i], TITLE_POPULATION_FLOOR);
    if (canon) {
      const useVal = normalizeToken(canon) === normalizeToken(orig) ? orig : canon;
      if (useVal !== orig) snapped[orig] = useVal;
      const k = normalizeToken(useVal); if (!seen.has(k)) { seen.add(k); out.push(useVal); }
    } else {
      unverified.push(orig);
      const k = normalizeToken(orig); if (!seen.has(k)) { seen.add(k); out.push(orig); }
    }
  });
  return { validated: out, snapped, unverified };
}

(async () => {
  const cases = [
    ['Clean titles', ['CEO', 'VP Sales', 'Property Manager']],
    ['Junk + real', ['particularly in government', 'Head of Strategy']],
    ['Dedup variants', ['VP of Sales', 'Vice President, Sales']],
    ['Owner family', ['Self Employed', 'Owner']],
    ['Compound split', ['CEO, CIO, COO, Janitor']],
    ['Slash compound', ['Owner/Founder']],
  ];
  for (const [label, titles] of cases) {
    const res = await validateTitles(titles);
    console.log(`\n## ${label}`);
    console.log('  in:        ', JSON.stringify(titles));
    console.log('  validated: ', JSON.stringify(res.validated));
    console.log('  snapped:   ', JSON.stringify(res.snapped));
    console.log('  unverified:', JSON.stringify(res.unverified));
  }

  // Floor calibration: dump num_people/score for a common query.
  console.log('\n## Floor calibration — fetchTitleTags("owner") raw tags:');
  const tags = await fetchTitleTags('owner');
  tags.slice(0, 12).forEach(t => console.log(`  ${String(t.num_people).padStart(9)}  score=${Math.round(t.score)}  ${t.display_name}`));
  console.log(`\n  (TITLE_POPULATION_FLOOR currently ${TITLE_POPULATION_FLOOR})`);
})();
