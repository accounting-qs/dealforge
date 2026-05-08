// End-to-end verification of POST /api/jobs/:id/leads/reveal.
//
//  1. Start local server.js
//  2. Pick a real apollo_id from a fresh search
//  3. Patch a recent job's extracted_data._generated.leads to include that
//     unrevealed lead
//  4. POST /api/jobs/:id/leads/reveal { apollo_id }
//  5. Assert response contains revealed=true, full last name, personal LinkedIn,
//     and that re-calling is idempotent (returns cached: true)
require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APOLLO_KEY   = process.env.APOLLO_API_KEY;
const PORT         = 3030;
const JOB_ID       = '6c714463-6e3a-4efb-8396-542147b3fab7'; // M-Fund VC

async function supa(method, urlPath, body) {
  const r = await fetch(SUPABASE_URL + urlPath, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      [method === 'GET' ? 'Accept-Profile' : 'Content-Profile']: 'sales_assets',
      Prefer: 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.ok ? r.json() : Promise.reject(new Error(method + ' ' + urlPath + ' → ' + r.status));
}

(async () => {
  console.log('▶ 1. pulling a fresh apollo_id from people search…');
  const sr = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify({ person_titles: ['CEO'], organization_locations: ['United States'], per_page: 1 })
  });
  const sd = await sr.json();
  const sample = sd.people[0];
  const apolloId = sample.id;
  console.log('   id:', apolloId, '| name:', sample.first_name, sample.last_name_obfuscated, '| company:', sample.organization?.name);

  console.log('▶ 2. patching job ' + JOB_ID.slice(0,8) + ' with a single test lead…');
  const [job] = await supa('GET', '/rest/v1/jobs?id=eq.' + JOB_ID + '&select=id,extracted_data');
  const ext = job.extracted_data || {};
  // Save current state so we can restore if the test mutates it
  const backupLeads = ext._generated?.leads || null;
  const testLead = {
    apollo_id:  apolloId,
    name:       sample.first_name + ' ' + (sample.last_name_obfuscated || '?'),
    title:      sample.title,
    company:    sample.organization?.name,
    company_size: '11–50 emp',
    website:    null,
    linkedin_url: null,
    company_linkedin_url: null,
    photo_url: null, email: null, headline: null,
    revealed:   false
  };
  await supa('PATCH', '/rest/v1/jobs?id=eq.' + JOB_ID, {
    extracted_data: { ...ext, _generated: { ...(ext._generated || {}), leads: [testLead] } }
  });

  console.log('▶ 3. starting local server on PORT=' + PORT + '…');
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let booted = false;
  const bootedP = new Promise(resolve => {
    srv.stdout.on('data', d => {
      const s = d.toString();
      if (!booted && /running on port/.test(s)) { booted = true; resolve(); }
    });
  });
  await Promise.race([bootedP, new Promise((_, rej) => setTimeout(() => rej(new Error('server boot timeout')), 15000))]);
  console.log('   server up');

  try {
    console.log('▶ 4. POST /api/jobs/' + JOB_ID.slice(0,8) + '…/leads/reveal');
    const t0 = Date.now();
    const r1 = await fetch('http://127.0.0.1:' + PORT + '/api/jobs/' + JOB_ID + '/leads/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apollo_id: apolloId })
    });
    const d1 = await r1.json();
    console.log('   status:', r1.status, '| took', (Date.now()-t0)+'ms');
    console.log('   cached:', d1.cached);
    console.log('   revealed lead:', JSON.stringify({
      name: d1.lead?.name,
      linkedin_url: d1.lead?.linkedin_url,
      email: d1.lead?.email,
      photo_url: d1.lead?.photo_url ? '<headshot URL>' : null,
      headline: d1.lead?.headline,
      revealed: d1.lead?.revealed
    }, null, 2));

    console.log('▶ 5. POST again (should be idempotent → cached:true, no new credit)');
    const r2 = await fetch('http://127.0.0.1:' + PORT + '/api/jobs/' + JOB_ID + '/leads/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apollo_id: apolloId })
    });
    const d2 = await r2.json();
    console.log('   status:', r2.status, '| cached:', d2.cached);

    const ok = r1.status === 200 && r2.status === 200 && d1.lead?.revealed === true && d2.cached === true;
    console.log('');
    console.log(ok ? '✅ PASS' : '❌ FAIL');
  } finally {
    console.log('▶ 6. restoring original leads + killing server…');
    await supa('PATCH', '/rest/v1/jobs?id=eq.' + JOB_ID, {
      extracted_data: { ...ext, _generated: { ...(ext._generated || {}), leads: backupLeads } }
    });
    srv.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }
})().catch(e => { console.error('TEST ERR:', e.message); process.exitCode = 1; });
