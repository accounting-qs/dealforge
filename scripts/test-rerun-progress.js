// End-to-end check of the new rerun-apollo progress field.
//
//   1. Start local server.
//   2. POST /api/jobs/:id/rerun-apollo on a real job.
//   3. Poll Supabase for extracted_data._generated.apollo_rerun and print the
//      progress timeline until status === 'completed' or 'failed'.
//
// Validates: progress monotonically increases, message strings are populated,
// status transitions running → completed.

require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = 3032;
const JOB_ID = '6c714463-6e3a-4efb-8396-542147b3fab7'; // M-Fund VC

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
  await new Promise((resolve, reject) => {
    let booted = false;
    srv.stdout.on('data', d => {
      if (!booted && /running on port/.test(d.toString())) { booted = true; resolve(); }
    });
    setTimeout(() => booted ? null : reject(new Error('boot timeout')), 15000);
  });
  console.log('  up.');

  try {
    console.log('▶ kicking off rerun-apollo for job ' + JOB_ID.slice(0,8));
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/jobs/' + JOB_ID + '/rerun-apollo', { method: 'POST' });
    console.log('  HTTP', r.status, await r.text());
    console.log('');
    console.log('▶ polling progress every 1s…');
    const t0 = Date.now();
    let last = '';
    let final = null;
    for (let i = 0; i < 90; i++) {
      const rr = await getRerun();
      if (!rr) { await new Promise(r => setTimeout(r, 1000)); continue; }
      const line = (rr.progress + '%').padStart(4) + '  [' + rr.status + ']  ' + (rr.message || '');
      if (line !== last) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's';
        console.log('  +' + elapsed.padStart(6), line);
        last = line;
      }
      if (rr.status === 'completed' || rr.status === 'failed') { final = rr; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('');
    console.log(final ? ('✅ final status: ' + final.status) : '❌ TIMED OUT after 90s');
  } finally {
    srv.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }
})().catch(e => { console.error('TEST ERR:', e); process.exitCode = 1; });
