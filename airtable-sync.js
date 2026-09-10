'use strict';
/**
 * Airtable → Supabase sync for the case-study library.
 *
 * Airtable ("Customer Testimonials" base) stays the place humans edit. This
 * pulls a read-only copy into sales_assets.case_study_* so the pipeline and the
 * portal can query it locally — no Airtable round-trip per render, and an asset
 * still builds when Airtable is down or rate-limited.
 *
 * Self-contained: imports nothing from server.js. server.js injects
 * supabaseRequest + storageUpload via configure(), the same pattern mcp-server.js
 * uses, so this file stays testable and server.js stays 2 lines longer.
 *
 * ── Two things that will bite if changed ────────────────────────────────────
 *
 * IMAGES ARE RE-HOSTED, NOT LINKED.
 *   Airtable attachment URLs are short-lived signed links that expire within
 *   hours. Storing them means every client logo in the portal breaks the same
 *   day, silently and long after the sync "succeeded". Each attachment is
 *   downloaded and written to the sales-assets bucket under case-studies/.
 *
 * UPSERT KEY IS THE AIRTABLE RECORD ID.
 *   Client names get corrected, so keying on name would duplicate the library
 *   on every re-sync. The record id is the only durable identity Airtable gives.
 */

const AIRTABLE_API   = 'https://api.airtable.com/v0';
const AIRTABLE_BASE  = process.env.AIRTABLE_BASE_ID || 'appDBh76I8NAiE4l8';
const BUCKET_PREFIX  = 'case-studies';

// Airtable's documented rate limit is 5 req/s per base. One request per ~250ms
// keeps us clearly under it — this runs rarely and is not worth optimising.
const REQUEST_GAP_MS = 250;

let _supabaseRequest = null;
let _storageUpload   = null;

function configure({ supabaseRequest, storageUpload }) {
  _supabaseRequest = supabaseRequest;
  _storageUpload   = storageUpload;
}

// Accept the obvious spellings. The underscore in API_KEY is easy to drop when
// typing it into a hosting dashboard, and a silent "not configured" is a
// miserable thing to debug from the outside.
const TOKEN_ENV_NAMES = ['AIRTABLE_API_KEY', 'AIRTABLE_APIKEY', 'AIRTABLE_TOKEN', 'AIRTABLE_PAT'];
const token = () => {
  for (const name of TOKEN_ENV_NAMES) {
    const v = String(process.env[name] || '').trim();
    if (v) return v;
  }
  return '';
};
// Which name actually supplied it — surfaced in Settings so a typo is visible.
const tokenEnvName = () => TOKEN_ENV_NAMES.find(n => String(process.env[n] || '').trim()) || null;
const isConfigured = () => token().length > 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Airtable REST ────────────────────────────────────────────────────────────

async function airtableList(table) {
  if (!isConfigured()) throw new Error('No Airtable token set (looked for: ' + TOKEN_ENV_NAMES.join(', ') + ')');
  const out = [];
  let offset = null;
  do {
    const url = new URL(`${AIRTABLE_API}/${AIRTABLE_BASE}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token()}` },
      signal: AbortSignal.timeout(30000)
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (body && body.error && (body.error.message || body.error.type)) || `HTTP ${r.status}`;
      throw new Error(`Airtable ${table}: ${msg}`);
    }
    out.push(...(body.records || []));
    offset = body.offset || null;
    if (offset) await sleep(REQUEST_GAP_MS);
  } while (offset);
  return out;
}

// ── Field coercion ───────────────────────────────────────────────────────────
// Airtable hands back whatever the column type is; every one of these can also
// be absent. Nulls are preserved deliberately — most rows have narrative but no
// campaign stats, and a fabricated 0 would read as a real result of zero.

const str = v => {
  if (v == null) return null;
  if (Array.isArray(v)) { const s = v.map(x => (x && x.name) || x).filter(Boolean).join(', '); return s || null; }
  if (typeof v === 'object') return v.name || null;
  const s = String(v).trim();
  return s || null;
};
const num = v => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const intOf = v => { const n = num(v); return n == null ? null : Math.round(n); };
const dateOnly = v => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
// Multi-selects arrive as arrays, single-selects as strings. "Use on tabs" gates
// which tabs a client may appear on, so it must always end up an array.
const tags = v => {
  if (v == null) return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  return list.map(x => String((x && x.name) || x).trim()).filter(Boolean);
};
const firstAttachment = v => (Array.isArray(v) && v.length && v[0] && v[0].url) ? v[0] : null;
const linkedIds = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

// ── Image re-hosting ─────────────────────────────────────────────────────────

const EXT_BY_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif'
};

/**
 * Downloads one Airtable attachment into the sales-assets bucket and returns its
 * public URL. Returns null on any failure — a missing logo must never fail the
 * whole sync, it just means that card renders without one.
 */
async function rehostAttachment(recordId, slot, att) {
  try {
    const r = await fetch(att.url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`download ${r.status}`);
    const type = (att.type || r.headers.get('content-type') || '').split(';')[0].trim();
    const ext  = EXT_BY_TYPE[type] || (String(att.filename || '').split('.').pop() || 'png').toLowerCase().slice(0, 5);
    const buf  = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('empty body');
    const path = `${BUCKET_PREFIX}/${recordId}/${slot}.${ext}`;
    const url  = await _storageUpload(path, buf, type || 'image/png');
    return url || null;
  } catch (e) {
    console.warn(`[airtable] could not re-host ${slot} for ${recordId}: ${e.message}`);
    return null;
  }
}

// ── Upsert ───────────────────────────────────────────────────────────────────

async function upsert(table, rows, conflictCol) {
  if (!rows.length) return 0;
  // Chunked so one oversized request cannot fail the whole table. PostgREST
  // merge-duplicates turns this into a real upsert on the unique column.
  const CHUNK = 50;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const r = await _supabaseRequest('POST', `/rest/v1/${table}?on_conflict=${conflictCol}`, slice, {
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    });
    if (r.status >= 400) throw new Error(`upsert ${table}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    written += slice.length;
  }
  return written;
}

// ── Row mappers ──────────────────────────────────────────────────────────────

async function mapClient(rec, rehostImages, counters, existingByRecId) {
  const f = rec.fields || {};
  const prior = existingByRecId.get(rec.id) || {};

  const headshotAtt = firstAttachment(f['Headshot']);
  const logoAtt     = firstAttachment(f['Logo']);

  // Only re-download when the source filename changed — a re-sync of 33 records
  // should not re-upload 66 images every time.
  let headshotUrl = prior.headshot_url || null;
  let logoUrl     = prior.logo_url || null;
  const headshotName = headshotAtt ? (headshotAtt.filename || null) : null;
  const logoName     = logoAtt ? (logoAtt.filename || null) : null;

  if (rehostImages && headshotAtt && (headshotName !== prior.headshot_source_name || !headshotUrl)) {
    headshotUrl = await rehostAttachment(rec.id, 'headshot', headshotAtt);
    if (headshotUrl) counters.images++;
  }
  if (rehostImages && logoAtt && (logoName !== prior.logo_source_name || !logoUrl)) {
    logoUrl = await rehostAttachment(rec.id, 'logo', logoAtt);
    if (logoUrl) counters.images++;
  }

  return {
    airtable_record_id:   rec.id,
    client_name:          str(f['Client']) || '(unnamed)',
    company:              str(f['Company']),
    website:              str(f['Website']),
    record_type:          str(f['Type']),
    headshot_url:         headshotUrl,
    headshot_source_name: headshotName,
    logo_url:             logoUrl,
    logo_source_name:     logoName,
    logo_type:            str(f['Logo type']),
    headshot_source:      str(f['Headshot source']),
    problem_they_solve:   str(f['Problem they solve']),
    how_they_help:        str(f['How they help']),
    best_used_for:        str(f['Best used for']),
    who_they_are:         str(f['Who they are']),
    key_quote:            str(f['Key quote']),
    industries:           str(f['Industries']),
    titles:               str(f['Titles']),
    geography:            str(f['Geography']),
    company_size:         str(f['Company size']),
    tam:                  intOf(f['TAM']),
    tam_confidence:       intOf(f['TAM confidence']),
    webinar_title:        str(f['Webinar title']),
    event_description:    str(f['Event description']),
    webinar_date:         dateOnly(f['Webinar date']),
    recording_url:        str(f['Recording URL']),
    registration_url:     str(f['Registration URL']),
    reference_asset_url:  str(f['Reference asset URL']),
    use_on_tabs:          tags(f['Use on tabs']),
    data_flags:           str(f['Data flags']),
    invites_sent:         intOf(f['Invites sent']),
    registrations:        intOf(f['Registrations']),
    attendees:            intOf(f['Attendees']),
    booked_calls:         intOf(f['Booked calls']),
    webinars_run:         intOf(f['Webinars run']),
    total_invites:        intOf(f['Total invites']),
    total_registrations:  intOf(f['Total registrations']),
    total_attendees:      intOf(f['Total attendees']),
    total_booked_calls:   intOf(f['Total booked calls']),
    stats_source:         str(f['Stats source']),
    stats_basis:          str(f['Stats basis']),
    synced_at:            new Date().toISOString(),
    updated_at:           new Date().toISOString()
  };
}

function mapTranscript(rec) {
  const f = rec.fields || {};
  return {
    airtable_record_id: rec.id,
    client_name:      str(f['Client']),
    company:          str(f['Company']),
    client_record_id: linkedIds(f['Clients'])[0] || null,
    status:           str(f['Status']),
    transcript:       str(f['Transcript']),
    video_url:        str(f['Video URL']),
    duration:         str(f['Duration']),
    speakers:         str(f['Speakers']),
    word_count:       intOf(f['Word count']),
    record_type:      str(f['Type']),
    slug:             str(f['Slug']),
    industry_niche:   str(f['Industry / Niche']),
    headline_result:  str(f['Headline result']),
    synced_at:        new Date().toISOString(),
    updated_at:       new Date().toISOString()
  };
}

// The Clips schema was not observable from the shared view, so each column tries
// a few plausible Airtable names. Unmapped fields are logged on the first real
// sync (see syncCaseStudies) so this can be tightened against the live base
// instead of guessed at again.
const pick = (f, ...names) => { for (const n of names) if (f[n] != null) return f[n]; return null; };
function mapClip(rec) {
  const f = rec.fields || {};
  return {
    airtable_record_id:   rec.id,
    title:                str(pick(f, 'Title', 'Name', 'Clip', 'Clip title')),
    client_name:          str(pick(f, 'Client', 'Client name')),
    client_record_id:     linkedIds(pick(f, 'Clients', 'Client'))[0] || null,
    transcript_record_id: linkedIds(pick(f, 'Transcripts', 'Transcript'))[0] || null,
    video_url:            str(pick(f, 'Video URL', 'URL', 'Clip URL', 'Link')),
    start_time:           str(pick(f, 'Start', 'Start time', 'From')),
    end_time:             str(pick(f, 'End', 'End time', 'To')),
    duration:             str(pick(f, 'Duration', 'Length')),
    quote:                str(pick(f, 'Quote', 'Transcript', 'Text', 'Caption')),
    topic:                str(pick(f, 'Topic', 'Theme', 'Tag', 'Tags', 'Category')),
    synced_at:            new Date().toISOString(),
    updated_at:           new Date().toISOString()
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function setSyncState(patch) {
  try {
    const r = await _supabaseRequest('GET', '/rest/v1/case_study_sync_state?order=id.asc&limit=1');
    const row = Array.isArray(r.body) ? r.body[0] : null;
    const body = { ...patch, updated_at: new Date().toISOString() };
    if (row) await _supabaseRequest('PATCH', `/rest/v1/case_study_sync_state?id=eq.${row.id}`, body, { 'Prefer': 'return=minimal' });
    else     await _supabaseRequest('POST', '/rest/v1/case_study_sync_state', body, { 'Prefer': 'return=minimal' });
  } catch (e) { console.warn('[airtable] could not record sync state:', e.message); }
}

async function getSyncState() {
  const r = await _supabaseRequest('GET', '/rest/v1/case_study_sync_state?order=id.asc&limit=1');
  return (Array.isArray(r.body) ? r.body[0] : null) || null;
}

/**
 * Pulls all three tables and upserts them. Clients first — transcripts and clips
 * reference client record ids, and syncing them in that order means a fresh
 * database is coherent even if a later table fails.
 */
async function syncCaseStudies({ rehostImages = true } = {}) {
  if (!isConfigured()) throw new Error('No Airtable token set. Add one of ' + TOKEN_ENV_NAMES.join(' / ') + ' in the Render environment.');
  const started = Date.now();
  const counters = { images: 0 };

  // Existing rows let us skip re-downloading images whose filename has not moved.
  const existing = await _supabaseRequest('GET',
    '/rest/v1/case_study_clients?select=airtable_record_id,headshot_url,headshot_source_name,logo_url,logo_source_name');
  const existingByRecId = new Map(
    (Array.isArray(existing.body) ? existing.body : []).map(r => [r.airtable_record_id, r]));

  const clientRecs = await airtableList('Clients');
  const clientRows = [];
  for (const rec of clientRecs) clientRows.push(await mapClient(rec, rehostImages, counters, existingByRecId));
  const clients = await upsert('case_study_clients', clientRows, 'airtable_record_id');

  await sleep(REQUEST_GAP_MS);
  const transcriptRecs = await airtableList('Transcripts');
  const transcripts = await upsert('case_study_transcripts', transcriptRecs.map(mapTranscript), 'airtable_record_id');

  await sleep(REQUEST_GAP_MS);
  let clips = 0;
  try {
    const clipRecs = await airtableList('Clips');
    // Surface the real Clips field names once, so the guessed mapping above can
    // be replaced with the actual ones rather than guessed at twice.
    if (clipRecs.length) {
      console.log('[airtable] Clips fields seen: ' + JSON.stringify(Object.keys(clipRecs[0].fields || {})));
    }
    clips = await upsert('case_study_clips', clipRecs.map(mapClip), 'airtable_record_id');
  } catch (e) {
    // Clips are supporting material; losing them must not fail a sync that got
    // the library itself.
    console.warn('[airtable] Clips sync failed (continuing):', e.message);
  }

  const summary = {
    clients, transcripts, clips,
    images_rehosted: counters.images,
    last_status: 'ok', last_error: null,
    last_synced_at: new Date().toISOString()
  };
  await setSyncState(summary);
  console.log(`[airtable] sync ok in ${Date.now() - started}ms — ${clients} clients, ${transcripts} transcripts, ${clips} clips, ${counters.images} images`);
  return summary;
}

module.exports = { configure, syncCaseStudies, getSyncState, isConfigured, setSyncState, tokenEnvName, TOKEN_ENV_NAMES, AIRTABLE_BASE };
