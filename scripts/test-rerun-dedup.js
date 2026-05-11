// Verifies the rerun-apollo path now produces 25 unique-company leads with
// a Size band populated — same shape handleLeadList produces. Previously
// rerun persisted 50 raw leads with empty Size cells.
require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = 3034;
const JOB_ID = '2c280a6c-b123-4fef-92bc-2f7e2b92a9e6'; // 4FP Agency latest

async function getJob() {
  const r = await fetch(SUPABASE_URL + '/rest/v1/jobs?id=eq.' + JOB_ID + '&select=extracted_data', {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Accept-Profile': 'sales_assets' },
    cache: 'no-store'
  });
  return (await r.json())[0];
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
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/jobs/' + JOB_ID + '/rerun-apollo', { method: 'POST' });
    console.log('  POST status:', r.status);
    // Wait for status === completed
    let final = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const job = await getJob();
      const rr = job?.extracted_data?._generated?.apollo_rerun;
      if (rr && (rr.status === 'completed' || rr.status === 'failed')) {
        final = { rr, ext: job.extracted_data };
        break;
      }
    }
    if (!final) { console.error('TIMED OUT'); return; }
    console.log('');
    console.log('rerun status :', final.rr.status, '|', final.rr.message);
    const gen = final.ext._generated;
    const leads = gen.leads || [];
    const icpRanges = final.ext.icp?.apollo_employee_ranges;
    console.log('ICP ranges   :', JSON.stringify(icpRanges));
    console.log('leads count  :', leads.length, '(expect ≤25)');
    console.log('unique cos   :', new Set(leads.map(l => l.company)).size, '(expect == leads count)');
    const withSize = leads.filter(l => l.company_size).length;
    console.log('with size    :', withSize, '/', leads.length);
    console.log('first 3:');
    leads.slice(0,3).forEach(l => console.log('  ' + l.name.padEnd(22), '| size:', JSON.stringify(l.company_size), '|', l.company));
    const ok = leads.length <= 25
      && leads.length === new Set(leads.map(l => l.company)).size
      && withSize === leads.length;
    console.log('');
    console.log(ok ? '✅ PASS' : '❌ FAIL');
  } finally {
    srv.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }
})().catch(e => { console.error('TEST ERR:', e); process.exitCode = 1; });
