// Full pipeline test — bypasses worker and Railway race
// Run: node test-pipeline.js
require('dotenv').config();

const APOLLO_KEY = process.env.APOLLO_API_KEY;

function normalizePerson(p) {
  const org = p.organization || {};
  const name = p.name
    || (p.first_name && (p.last_name || p.last_name_obfuscated)
        ? `${p.first_name} ${p.last_name || p.last_name_obfuscated}`.trim()
        : (p.first_name || null));
  const company = p.organization_name || org.name || null;
  return { name, title: p.title, company, has_email: p.has_email, _source: 'apollo' };
}

async function apolloPeopleSearch(payload) {
  const body = { per_page: 25, page: 1, ...payload };
  delete body.q_keywords;       // causes 0 on api_search
  delete body.contact_email_status; // causes 0 on api_search

  console.log('\n→ Sending to Apollo api_search:', JSON.stringify(body, null, 2));

  const res = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) { console.error(`✗ HTTP ${res.status}:`, data); return []; }

  console.log(`\n✓ HTTP 200 | total_entries: ${data.total_entries} | people: ${data.people?.length}`);

  const people = (data.people || []).filter(p => {
    const n = normalizePerson(p);
    if (!n.name || !n.title || !n.company) {
      console.log(`  ✗ filtered out: name="${n.name}" title="${n.title}" company="${n.company}"`);
      return false;
    }
    return true;
  }).map(p => normalizePerson(p));

  console.log(`  → ${people.length}/${data.people?.length} passed filter`);
  console.log('\nSample:');
  people.slice(0, 5).forEach((p, i) =>
    console.log(`  ${i+1}. ${p.name} | ${p.title} | ${p.company} | has_email: ${p.has_email}`)
  );
  return { total_entries: data.total_entries, people };
}

async function run() {
  console.log('=== Selawny ICP Apollo Search Test ===');
  const result = await apolloPeopleSearch({
    person_titles: ["CEO", "President", "Owner", "Managing Director", "Founder", "Principal"],
    person_seniorities: ["owner", "founder", "c_suite", "partner"],
    organization_locations: ["New York, United States"],
    organization_num_employees_ranges: ["1,10", "11,50", "51,200", "201,500"]
  });

  console.log(`\n=== SUMMARY ===`);
  console.log(`TAM: ${result.total_entries || 0}`);
  console.log(`Leads: ${result.people?.length || 0}`);
}

run().catch(console.error);


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const APOLLO_KEY = process.env.APOLLO_API_KEY;

function normalizePerson(p, source) {
  const org = p.organization || p.account || {};
  const name = p.name
    || (p.first_name && (p.last_name || p.last_name_obfuscated)
        ? `${p.first_name} ${p.last_name || p.last_name_obfuscated}`.trim()
        : (p.first_name || null));
  const company = p.organization_name || org.name || org.short_description || null;
  const website = p.website_url || org.website_url || org.primary_domain || null;
  const employeeCount = p.organization_num_employees || org.estimated_num_employees || org.employees || null;
  return { name, title: p.title, company, company_size: employeeCount, website, _source: source };
}

async function apolloPeopleSearch(payload) {
  const body = {
    per_page: 25,
    page: 1,
    sort_by_field: 'person_name',
    sort_ascending: true,
    ...payload
  };
  // Strip q_keywords — not supported by api_search endpoint
  delete body.q_keywords;
  // Strip contact_email_status — causes 0 results on api_search
  delete body.contact_email_status;

  console.log('\n→ Sending to Apollo:', JSON.stringify(body, null, 2));

  const res = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-api-key': APOLLO_KEY
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`✗ HTTP ${res.status}:`, err);
    return { total_entries: 0, people: [] };
  }

  const data = await res.json();
  console.log(`✓ HTTP 200 | total_entries: ${data.total_entries} | people: ${data.people?.length}`);

  const people = (data.people || []).filter(p => {
    const n = normalizePerson(p, 'apollo');
    const passes = n.name && n.name.length > 2 && n.title && n.company;
    if (!passes) console.log(`  ✗ filtered: name=${n.name} title=${n.title} company=${n.company}`);
    return passes;
  }).map(p => normalizePerson(p, 'apollo'));

  console.log(`  → ${people.length} people passed filter`);
  if (people.length > 0) {
    console.log('\nSample leads:');
    people.slice(0, 3).forEach((p, i) => console.log(`  ${i+1}. ${p.name} | ${p.title} | ${p.company}`));
  }

  return { total_entries: data.total_entries || 0, people };
}

async function run() {
  // Selawny ICP
  const payload = {
    person_titles: ["CEO", "President", "Owner", "Managing Director", "Founder", "Principal"],
    person_seniorities: ["owner", "founder", "c_suite", "partner"],
    organization_locations: ["New York, United States"],
    organization_num_employees_ranges: ["1,10", "11,50", "51,200", "201,500"],
    per_page: 25
  };

  console.log('=== Testing Selawny ICP Lead Search ===');
  const result = await apolloPeopleSearch(payload);

  console.log('\n=== FINAL RESULT ===');
  console.log(`Total available (TAM): ${result.total_entries}`);
  console.log(`Leads returned: ${result.people.length}`);

  if (result.people.length > 0) {
    // Update DB directly with the results
    console.log('\n→ Saving to DB...');
    const { error } = await supabase.schema('sales_assets').from('tasks')
      .update({
        status: 'completed',
        output_data: {
          leads: result.people,
          total: result.total_entries,
          recommendedOutreach: Math.max(1000, Math.round(result.total_entries / 3 / 1000) * 1000),
          tamSource: 'apollo_api_live',
          apollo_diagnostics: { wasRelaxed: false, relaxationLog: [], finalPayload: payload }
        },
        completed_at: new Date().toISOString(),
        error_message: null
      })
      .eq('job_id', '45503716-f171-4c92-8ce1-63287c2316d8')
      .eq('task_type', 'lead_list');

    if (error) console.error('DB save error:', error);
    else console.log('✓ Saved to DB successfully!');
  }
}

run().catch(console.error);
