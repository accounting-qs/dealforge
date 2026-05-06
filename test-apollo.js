// Quick Apollo endpoint test — run with: node test-apollo.js
require('dotenv').config();

const APOLLO_KEY = process.env.APOLLO_API_KEY;

const payload = {
  person_titles: ["CEO", "President", "Owner", "Founder"],
  person_seniorities: ["owner", "founder", "c_suite"],
  organization_locations: ["New York, United States"],
  organization_num_employees_ranges: ["1,10", "11,50", "51,200", "201,500"],
  per_page: 25,
  page: 1
};

async function test() {
  console.log('Testing Apollo api_search endpoint...');
  console.log('Payload:', JSON.stringify(payload, null, 2));

  const res = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-api-key': APOLLO_KEY
    },
    body: JSON.stringify(payload)
  });

  console.log(`\nHTTP Status: ${res.status} ${res.statusText}`);
  const data = await res.json();
  
  if (!res.ok) {
    console.error('Error:', JSON.stringify(data));
    return;
  }

  // Log full response structure to understand new endpoint format
  console.log('\nFull response top-level keys:', Object.keys(data));
  console.log('pagination:', JSON.stringify(data.pagination));
  console.log('breadcrumbs:', JSON.stringify(data.breadcrumbs));
  console.log('people count:', data.people?.length);
  console.log('contacts count:', data.contacts?.length);
  console.log('num_fetch_result:', data.num_fetch_result);
  console.log('total_entries:', data.total_entries);

  if (data.people?.length > 0) {
    console.log('\nFirst person raw keys:', Object.keys(data.people[0]));
    console.log('First person:', JSON.stringify(data.people[0], null, 2));
  }
}

test().catch(console.error);
