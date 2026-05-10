// Verifies rerun-apollo works on 4FP's stripped ICP (apollo_geography,
// apollo_employee_ranges, apollo_keyword, person_seniorities all undefined/null).
// Expected: search succeeds with whatever filters ARE present, no crash on
// missing fields.
require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = 3033;
const JOB_ID = '1af468d8-2c78-43c5-a6df-62dfe5ea8d5f'; // 4FP Agency

async function getRerun() {
  const r = await fetch(SUPABASE_URL + '/rest/v1/jobs?id=eq.' + JOB_ID + '&select=extracted_data', {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Accept-Profile': 'sales_assets' },
    cache: 'no-store'
  });
  const [row] = await r.json();
  return row?.extracted_data?._generated?.apollo_rerun || null;
}

(async () => {
  console.log('▶ booting local server on :' + PORT);
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  srv.stderr.on('data', d => stderr += d.toString());
  await new Promise((resolve, reject) => {
    let booted = false;
    srv.stdout.on('data', d => {
      if (!booted && /running on port/.test(d.toString())) { booted = true; resolve(); }
    });
    setTimeout(() => booted ? null : reject(new Error('boot timeout: ' + stderr.slice(0,400))), 15000);
  });
  console.log('  up.');

  try {
    console.log('▶ rerun-apollo on 4FP (stripped ICP)');
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/jobs/' + JOB_ID + '/rerun-apollo', { method: 'POST' });
    console.log('  HTTP', r.status, await r.text());
    console.log('');
    const t0 = Date.now();
    let last = '', final = null;
    for (let i = 0; i < 90; i++) {
      const rr = await getRerun();
      if (!rr) { await new Promise(r => setTimeout(r, 1000)); continue; }
      const line = (rr.progress + '%').padStart(4) + '  [' + rr.status + ']  ' + (rr.message || '');
      if (line !== last) {
        console.log('  +' + ((Date.now()-t0)/1000).toFixed(1).padStart(5) + 's', line);
        last = line;
      }
      if (rr.status === 'completed' || rr.status === 'failed') { final = rr; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('');
    console.log(final ? ('✅ ' + final.status) : '❌ TIMED OUT');
  } finally {
    srv.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }
})().catch(e => { console.error('TEST ERR:', e); process.exitCode = 1; });
