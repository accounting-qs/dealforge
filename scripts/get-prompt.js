const fs = require('fs');
require('dotenv').config();
const fetch = require('node-fetch');

async function main() {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/prompts?slug=eq.icp_translation`, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
    }
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}
main().catch(console.error);
