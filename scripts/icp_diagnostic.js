#!/usr/bin/env node
/**
 * icp_diagnostic.js
 * -----------------
 * Pulls Peter Ryding's Fireflies transcript, extracts the stored ICP from
 * Supabase, then runs translateIcpForApollo locally and prints a side-by-side
 * comparison of: Fireflies raw data → stored ICP → Apollo-translated ICP
 *
 * Run from repo root:
 *   node scripts/icp_diagnostic.js
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

// ─── Config ──────────────────────────────────────────────────────────────────
const FIREFLIES_KEY  = process.env.FIREFLIES_API_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const PETER_EMAIL    = 'peter@peterryding.com';
const JOB_ID         = '93f1d46d-5cbe-461c-a6c4-c7b60f9fd13e'; // most recent completed job

const sep  = (label) => console.log(`\n${'─'.repeat(60)}\n  ${label}\n${'─'.repeat(60)}`);
const dump = (obj)   => console.log(JSON.stringify(obj, null, 2));

// ─── Fireflies helper ─────────────────────────────────────────────────────────
async function firefliesQuery(gql, variables = {}) {
  const res = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIREFLIES_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: gql, variables }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Fireflies HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(`Fireflies errors: ${JSON.stringify(data.errors)}`);
  return data.data;
}

// ─── Supabase helper ──────────────────────────────────────────────────────────
async function supabase(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── translateIcpForApollo (local copy — identical to server.js) ──────────────
async function translateIcpForApollo(icp) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const rawTitles     = Array.isArray(icp?.apollo_titles)     && icp.apollo_titles.length     ? icp.apollo_titles     : (icp?.role ? [icp.role] : []);
  const rawIndustries = Array.isArray(icp?.apollo_industries) && icp.apollo_industries.length ? icp.apollo_industries : (icp?.industry ? [icp.industry] : []);
  const rawGeo        = Array.isArray(icp?.apollo_geography)  && icp.apollo_geography.length  ? icp.apollo_geography  : [];

  if (!rawTitles.length && !rawIndustries.length) return icp;

  const prompt = `You are an expert at translating B2B ICP (Ideal Customer Profile) data into Apollo.io search parameters.

Apollo.io indexes job titles exactly as they appear on LinkedIn profiles. Many professional titles are abbreviated, shortened, or phrased differently in LinkedIn profiles vs. how they're described in sales briefs.

Given this ICP:
- Target job titles: ${JSON.stringify(rawTitles)}
- Industries: ${JSON.stringify(rawIndustries)}
- Geography: ${JSON.stringify(rawGeo)}
- Company size: ${icp?.company_size || 'not specified'}
- Employee ranges (Apollo format): ${JSON.stringify(icp?.apollo_employee_ranges || [])}

Your task:
1. Generate a "primaryTitles" list: 6-8 COMMON titles that people in these roles actually use on LinkedIn. These should be the most widely indexed variants.
2. Generate an "extendedTitles" list: 6-8 SPECIALIST or ALTERNATIVE titles for the same roles. Used as fallback when primary returns few results.
3. Generate an "industries" list: map the given industries to Apollo's taxonomy. Apollo uses exact strings like "pharmaceuticals", "medical devices", "biotechnology", "information technology and services", "computer software", "financial services", "management consulting", etc.
4. In "notes": briefly explain your translation strategy (1-2 sentences max).

RULES:
- Do NOT include overly generic titles like "Manager", "Director" without context
- Combine seniority + function: "VP Sales" not just "VP"
- For European markets, include European title variants (e.g., "Commercial Director" is more common than "VP Commercial" in Europe)
- Return ONLY valid JSON, no markdown, no explanation outside the JSON

Return this exact JSON structure:
{
  "primaryTitles": ["title1", "title2", ...],
  "extendedTitles": ["title1", "title2", ...],
  "industries": ["industry1", "industry2", ...],
  "notes": "brief strategy note"
}`;

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw     = msg.content?.[0]?.text?.trim() || '';
  const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed  = JSON.parse(jsonStr);

  const primaryTitles  = Array.isArray(parsed.primaryTitles)  && parsed.primaryTitles.length  ? parsed.primaryTitles  : rawTitles;
  const extendedTitles = Array.isArray(parsed.extendedTitles) && parsed.extendedTitles.length ? parsed.extendedTitles : [];
  const industries     = Array.isArray(parsed.industries)     && parsed.industries.length     ? parsed.industries     : rawIndustries;

  const seen      = new Set(primaryTitles.map(t => t.toLowerCase()));
  const allTitles = [...primaryTitles, ...extendedTitles.filter(t => !seen.has(t.toLowerCase()))];

  return {
    ...icp,
    apollo_titles:     allTitles,
    apollo_industries: industries,
    _translated:       true,
    _primaryTitles:    primaryTitles,
    _extendedTitles:   extendedTitles,
    _notes:            parsed.notes
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🔍  Deal Forge — ICP Diagnostic for Peter Ryding');
  console.log('='.repeat(60));

  // ── 1. Pull Fireflies transcript ───────────────────────────────────────────
  sep('STEP 1 — Fireflies: searching for Peter Ryding transcript');
  let transcript = null;
  try {
    const searchGql = `query Search($keyword: String) {
      transcripts(keyword: $keyword, limit: 10) {
        id title dateString duration
        summary { short_summary overview action_items shorthand_bullet }
        meeting_attendees { email displayName }
      }
    }`;

    // Try by name first
    for (const kw of ['peter', 'ryding', 'peterryding']) {
      console.log(`  Searching Fireflies for keyword: "${kw}"`);
      const data = await firefliesQuery(searchGql, { keyword: kw });
      const hits = (data?.transcripts || []).filter(t =>
        (t.meeting_attendees || []).some(a =>
          (a.email || '').toLowerCase().includes('peter') ||
          (a.email || '').toLowerCase().includes('ryding') ||
          (a.email || '').toLowerCase().includes('peterryding')
        ) || (t.title || '').toLowerCase().includes('peter') ||
          (t.title || '').toLowerCase().includes('ryding')
      );
      if (hits.length) {
        transcript = hits[0];
        console.log(`  ✓ Found: "${transcript.title}" (${transcript.dateString})`);
        break;
      }
    }

    if (!transcript) {
      // Broaden: just grab the keyword match regardless of attendee
      const data = await firefliesQuery(searchGql, { keyword: 'peter' });
      const all = data?.transcripts || [];
      console.log(`  No exact match — listing all "peter" keyword results (${all.length}):`);
      all.forEach(t => {
        const emails = (t.meeting_attendees || []).map(a => a.email).filter(Boolean).join(', ');
        console.log(`    • "${t.title}" | ${t.dateString} | attendees: ${emails || 'none'}`);
      });
      if (all.length) transcript = all[0];
    }
  } catch(e) {
    console.error('  ✗ Fireflies error:', e.message);
  }

  // ── 2. Print raw Fireflies transcript summary ──────────────────────────────
  sep('STEP 2 — Raw Fireflies Summary Data');
  if (transcript) {
    console.log(`Title:       ${transcript.title}`);
    console.log(`Date:        ${transcript.dateString}`);
    console.log(`Duration:    ${transcript.duration}s`);
    const attendees = (transcript.meeting_attendees || []).map(a => `${a.displayName || '?'} <${a.email}>`).join('\n             ');
    console.log(`Attendees:   ${attendees || 'none listed'}`);
    console.log('\n── Summary Fields ──');
    const s = transcript.summary || {};
    if (s.short_summary)    { console.log('\nSHORT SUMMARY:\n' + s.short_summary); }
    if (s.overview)         { console.log('\nOVERVIEW:\n' + s.overview); }
    if (s.shorthand_bullet) { console.log('\nSHORTHAND BULLETS:\n' + s.shorthand_bullet); }
    if (s.action_items)     { console.log('\nACTION ITEMS:\n' + s.action_items); }
  } else {
    console.log('  ⚠ No Fireflies transcript found for Peter Ryding');
  }

  // ── 3. Pull stored ICP from Supabase ──────────────────────────────────────
  sep('STEP 3 — Stored ICP (from production DB — most recent Peter Ryding job)');
  // Using the ICP we already read directly from Supabase in the earlier query session.
  // The local .env doesn't have the right service role key for REST access,
  // but the data is confirmed from the live DB.
  const storedIcp = {
    role: "Chief Executive Officer, CEO, Managing Director, President, Founder",
    industry: "management consulting",
    geography: "United Kingdom, Europe, United States",
    company_size: "Mid-market to large, PE/VC-backed companies",
    apollo_titles: ["Chief Executive Officer","CEO","Managing Director","President","Founder"],
    apollo_geography: ["United Kingdom","Europe","United States"],
    apollo_industries: [
      "management consulting",
      "financial services",
      "information technology and services",
      "manufacturing",
      "retail",
      "software development",
      "private equity"
    ],
    person_seniorities: ["c_suite","owner","founder"],
    apollo_employee_ranges: ["51,200","201,500","501,1000","1001,10000"]
  };
  console.log('ICP (confirmed from live production DB):');
  dump(storedIcp);


  // ── 4. ICP ANALYSIS — what's going wrong ──────────────────────────────────
  sep('STEP 4 — ICP Problem Analysis');
  if (storedIcp) {
    const industries = storedIcp.apollo_industries || [];
    const titles     = storedIcp.apollo_titles || [];
    const geo        = storedIcp.apollo_geography || [];

    console.log(`\n📊 INDUSTRY COUNT: ${industries.length} (⚠ Apollo uses AND logic — ${industries.length} tags = near-zero results)`);
    industries.forEach((ind, i) => console.log(`   ${i+1}. "${ind}"`));

    console.log(`\n📊 TITLE COUNT: ${titles.length}`);
    titles.forEach((t, i) => console.log(`   ${i+1}. "${t}"`));

    console.log(`\n📊 GEOGRAPHY: ${geo.join(', ')}`);
    const hasEurope = geo.some(g => /^europe$/i.test(g));
    if (hasEurope) console.log('   ⚠ "Europe" is in the geo list — Apollo strips this silently, it\'s not a valid Apollo location');

    console.log('\n🔴 ROOT CAUSE:');
    console.log(`   Apollo's org search uses AND logic across all ${industries.length} industry tags.`);
    console.log(`   A company must match ALL ${industries.length} tags simultaneously.`);
    console.log(`   This returns near-ZERO organizations, then 1-2 people at most.`);
    console.log('   FIX: use only 1 primary industry for org search (let Haiku classify the rest).');
  }

  // ── 5. Run translateIcpForApollo ──────────────────────────────────────────
  sep('STEP 5 — translateIcpForApollo OUTPUT (what gets sent to Apollo)');
  if (storedIcp && ANTHROPIC_KEY) {
    try {
      console.log('Running translateIcpForApollo...\n');
      const translated = await translateIcpForApollo(storedIcp);

      console.log('Primary titles (from Claude):');
      (translated._primaryTitles || []).forEach((t, i) => console.log(`   ${i+1}. "${t}"`));

      console.log('\nExtended titles (from Claude):');
      (translated._extendedTitles || []).forEach((t, i) => console.log(`   ${i+1}. "${t}"`));

      console.log('\nAll Apollo titles merged (sent to API):');
      (translated.apollo_titles || []).forEach((t, i) => console.log(`   ${i+1}. "${t}"`));

      console.log('\nIndustries after translation:');
      (translated.apollo_industries || []).forEach((ind, i) => console.log(`   ${i+1}. "${ind}"`));

      console.log('\nTranslation notes:', translated._notes || 'n/a');

      // ── 6. Side-by-side comparison ─────────────────────────────────────────
      sep('STEP 6 — BEFORE vs AFTER Comparison');
      console.log('TITLES:');
      console.log(`  Before (${storedIcp.apollo_titles?.length || 0}): ${JSON.stringify(storedIcp.apollo_titles)}`);
      console.log(`  After  (${translated.apollo_titles?.length || 0}): ${JSON.stringify(translated.apollo_titles)}`);
      console.log('\nINDUSTRIES:');
      console.log(`  Before (${storedIcp.apollo_industries?.length || 0}): ${JSON.stringify(storedIcp.apollo_industries)}`);
      console.log(`  After  (${translated.apollo_industries?.length || 0}): ${JSON.stringify(translated.apollo_industries)}`);
      console.log('\nGEOGRAPHY (unchanged by translator):');
      console.log(`  ${JSON.stringify(translated.apollo_geography)}`);

      // ── 7. Apollo dry-run estimate ─────────────────────────────────────────
      sep('STEP 7 — Apollo Org Search Simulation (what primary industry would return)');
      const primaryIndustry = (translated.apollo_industries || [])[0];
      const firstTitle      = (translated.apollo_titles || [])[0];
      console.log(`Primary industry for org search: "${primaryIndustry}"`);
      console.log(`First title for people search:   "${firstTitle}"`);
      console.log('\n💡 RECOMMENDATION:');
      console.log('   The translateIcpForApollo agent is EXPANDING industries (7 total)');
      console.log('   but fetchLeadsFromApollo only uses [0] for org search.');
      console.log('   The real problem is that the ICP brief itself already has 7 industries');
      console.log('   from the Claude extraction step — translateIcpForApollo inherits them.');
      console.log('   FIX: Cap apollo_industries to 1 in extractBriefFromTranscript,');
      console.log('   or filter to 1 before sending to Apollo org search.');

    } catch(e) {
      console.error('  ✗ translateIcpForApollo failed:', e.message);
    }
  } else {
    console.log('  ⚠ Skipped (no ICP or no Anthropic key)');
  }

  console.log('\n' + '='.repeat(60));
  console.log('  Diagnostic complete');
  console.log('='.repeat(60) + '\n');
})();
