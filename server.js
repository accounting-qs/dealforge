'use strict';
// Load .env file first — must be before ANY process.env reads
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');

const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg' };

// ── Ephemeral progress jobs (prefetch + extract-brief) ───────────────────────
// In-memory only. Reps poll GET /api/<kind>/:id while a background async block
// pushes progress updates via setProgress(). Mirrors the rerun-apollo pattern
// but skips the Supabase round-trip per tick — the data is ephemeral, lives
// for ~10 minutes, and rebuilding the work on a server restart is fine: the
// client just retries from the New Job UI.
const _progressJobs = new Map(); // id → { kind, progress, step, status, result, error, updated_at }
const PROGRESS_TTL_MS = 10 * 60 * 1000;
function newProgressJob(kind) {
  const id = crypto.randomUUID();
  _progressJobs.set(id, { kind, progress: 0, step: 'Starting…', status: 'running', updated_at: Date.now() });
  return id;
}
function setProgress(id, patch) {
  const cur = _progressJobs.get(id);
  if (!cur) return;
  _progressJobs.set(id, { ...cur, ...patch, updated_at: Date.now() });
}
function getProgress(id) { return _progressJobs.get(id) || null; }
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of _progressJobs) {
    if (j.status !== 'running' && now - j.updated_at > PROGRESS_TTL_MS) _progressJobs.delete(id);
  }
}, 60 * 1000).unref();

// ── Prompt templates — loaded from files at startup ───────────────────────────
const PROMPTS_DIR   = path.join(__dirname, 'prompts');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
let WEBINAR_SYSTEM_TEMPLATE = '';
let WEBINAR_USER_TEMPLATE   = '';
let WEBINAR_FALLBACK_FORMAT = '';
let ROI_MODEL_TEMPLATE      = '';
let CALENDAR_VISUAL_TEMPLATE = '';
try {
  WEBINAR_SYSTEM_TEMPLATE  = fs.readFileSync(path.join(PROMPTS_DIR,   'webinar_titles_system.txt'), 'utf8');
  WEBINAR_USER_TEMPLATE    = fs.readFileSync(path.join(PROMPTS_DIR,   'webinar_titles_user.txt'),   'utf8');
  WEBINAR_FALLBACK_FORMAT  = fs.readFileSync(path.join(PROMPTS_DIR,   'webinar_titles_fallback_format.txt'), 'utf8');
  console.log('[Prompts] Loaded webinar title templates');
} catch(e) { console.warn('[Prompts] Could not load webinar templates:', e.message); }
try {
  ROI_MODEL_TEMPLATE       = fs.readFileSync(path.join(TEMPLATES_DIR, 'roi_model.html'),       'utf8');
  CALENDAR_VISUAL_TEMPLATE = fs.readFileSync(path.join(TEMPLATES_DIR, 'calendar_visual.html'), 'utf8');
  console.log('[Templates] Loaded roi_model, calendar_visual');
} catch(e) { console.warn('[Templates] Could not load HTML templates:', e.message); }

// Lazy template loader. If the startup read above failed for any reason
// (transient FS issue during deploy, partial container state, etc.) the cached
// template stays as empty string and every task that uses it dies with
// "template not loaded". This helper re-reads from disk at task time so the
// pipeline self-heals on the next worker tick instead of needing a redeploy.
function ensureTemplate(filename) {
  try {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
    console.log(`[Templates] Lazy-loaded ${filename} (${content.length} chars)`);
    return content;
  } catch (e) {
    console.warn(`[Templates] Lazy-load failed for ${filename}: ${e.message}`);
    return '';
  }
}

function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null) ? vars[k] : '');
}

// Robustly extract a JSON object from an LLM response. Handles three failure
// modes we've seen in prod: (1) Claude wraps the JSON in a markdown code fence,
// (2) Claude appends a sentence with curly braces after the JSON (breaks the
// greedy /\{[\s\S]*\}/ regex), (3) Claude prefixes a "Here is the JSON:" line.
//
// Returns the parsed object or null. Never throws.
function extractJsonObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences
  const fenced = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (fenced) s = fenced[1].trim();
  // Direct parse
  try { return JSON.parse(s); } catch (_) { /* fall through */ }
  // Brace-balanced extraction: find first `{`, walk forward respecting strings
  // and escapes, return when we hit the matching `}` at depth 0.
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const block = s.slice(start, i + 1);
        try { return JSON.parse(block); } catch (_) { return null; }
      }
    }
  }
  return null;
}

// ── Supabase REST helper ───────────────────────────────────────────────────────
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const USE_SUPABASE        = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

// Sales-assets schema profile header (PostgREST non-public schema routing)
function schemaHeaders(method) {
  return method === 'GET' || method === 'HEAD'
    ? { 'Accept-Profile': 'sales_assets' }
    : { 'Content-Profile': 'sales_assets' };
}

async function supabaseRequest(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url     = new URL(SUPABASE_URL + urlPath);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...schemaHeaders(method),
        ...extraHeaders
      }
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Copy Brain — DB-backed copywriting principles + business context + format rules ──
// Consumed by generateWebinarTitles to fill the {{business_context_block}},
// {{format_rules_block}}, {{principles_block}} placeholders in the system prompt.
// Falls back to the file-based WEBINAR_FALLBACK_FORMAT if DB config is empty.
// Tiny HTML → markdown converter. Calendar Examples come from a contenteditable
// WYSIWYG editor that emits HTML; we strip it to clean markdown so Claude sees
// natural prompt text rather than raw <p>/<strong>/<ul> tags. Only handles the
// tags the editor produces — not a general-purpose converter.
function htmlToMarkdown(html) {
  if (!html) return '';
  let md = String(html);
  // Headers
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  // Lists — handle ul + ol separately so numbering survives
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, function(_, inner) {
    return '\n' + inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  });
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, function(_, inner) {
    let i = 0;
    return '\n' + inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, function(_, item) { i++; return i + '. ' + item + '\n'; });
  });
  // Bold + italic
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, '**$2**');
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, '*$2*');
  // Paragraphs and line breaks
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<div[^>]*>/gi, '\n').replace(/<\/div>/gi, '');
  // Strip any remaining tags
  md = md.replace(/<[^>]+>/g, '');
  // Decode entities
  md = md.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  // Cleanup
  md = md.replace(/\n{3,}/g, '\n\n').trim();
  return md;
}

// Parse a stored Calendar Example body (rich-text HTML or markdown) into the
// 12-field webinar_titles variant schema. The settings UI stores each example
// as a single Title + Description blob; this recovers the structure at
// prompt-build time so Claude sees demonstrations in the SAME shape it must
// produce. Demonstrations dominate over instructions, so rendering examples
// in the old shape (Title + Description blob) was teaching Claude to ignore
// the 12-field schema. Returns null fields where the example doesn't carry
// content for that slot (e.g. for_line — examples don't include one).
function parseExampleDescription(rawDesc) {
  if (!rawDesc) return null;
  const md = /<[a-z][^>]*>/i.test(rawDesc) ? htmlToMarkdown(rawDesc) : String(rawDesc);
  const paragraphs = md.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (!paragraphs.length) return null;

  const out = {
    conditional_opener: null, proof_story: null, contrast_frame: null,
    session_promise: null, rsvp_block: null, bullets: [],
    reframe_line: null, urgency_close: null, ps_replay: null, for_line: null,
  };

  const bulletRe = /^[\u{1F4A5}\u{1F680}]/u;          // 💥 or 🚀 prefix
  const dontApostrophe = /(don['’]t|do not)/i;
  for (const para of paragraphs) {
    if (bulletRe.test(para)) {
      const lines = para.split(/\n/).map(l => l.trim()).filter(l => bulletRe.test(l));
      out.bullets.push(...lines);
      continue;
    }
    if (/^you['’]?ll discover how to:?\s*$/i.test(para)) continue;
    if (/^P\.?\s*S\.?\b/i.test(para))                                 { out.ps_replay      = para; continue; }
    if (/^Click\s*[""'"“”]?\s*YES/i.test(para))             { out.rsvp_block     = para; continue; }
    if (/^Instead of\b/i.test(para))                                  { out.contrast_frame = para; continue; }
    if (/^In this session\b/i.test(para))                             { out.session_promise= para; continue; }
    if (/^Most\b/i.test(para) && dontApostrophe.test(para) && /\bhave\b/i.test(para)) { out.reframe_line = para; continue; }
    // urgency_close anchor: must combine "aren't" with a comparative-winning
    // verb (winning / growing fastest / leading). Without the winning-verb
    // requirement, openers that start "The best X aren't losing to Y" (which
    // is a contrast-style opener, not an urgency close) get misclassified.
    if (/^The\b/i.test(para) && /aren['’]t\b/i.test(para) && /(winning|growing fastest|growing in 20|leading|on top)/i.test(para)) {
      out.urgency_close = para; continue;
    }
    if (/^(Built for|Designed for|For\s+[A-Z])/.test(para))           { out.for_line       = para.replace(/^(Built for|Designed for|For\s+)/, '').trim(); continue; }
    // Fallthrough: first two unclassified paragraphs are opener + proof story
    if (!out.conditional_opener) { out.conditional_opener = para; continue; }
    if (!out.proof_story)        { out.proof_story        = para; continue; }
    // Extra paragraphs we can't classify are ignored — better to teach a clean
    // subset than dilute the example with unlabelled prose.
  }
  return out;
}

async function loadCopyBrain() {
  try {
    const [pr, cr, er] = await Promise.all([
      supabaseRequest('GET', '/rest/v1/copy_brain_principles?enabled=eq.true&order=position.asc'),
      supabaseRequest('GET', '/rest/v1/copy_brain_config?order=id.asc&limit=1'),
      supabaseRequest('GET', '/rest/v1/copy_brain_examples?enabled=eq.true&order=position.asc'),
    ]);
    const principles = Array.isArray(pr.body) ? pr.body : [];
    const config = (Array.isArray(cr.body) ? cr.body[0] : null) || { business_context: '', format_rules: '' };
    const examples = Array.isArray(er.body) ? er.body : [];
    const principlesBlock = principles.length
      ? principles.map(p => `- ${p.text}`).join('\n')
      : [
          '- Write as the prospect company hosting, never Quantum Scaling.',
          '- Front-load ICP role or core outcome in title first 40 chars.',
          '- Bullets are SPECIFIC PROMISES, not topics. Shape adapts to host business_model:',
          '    • Educational hosts (consulting / coaching / agency) → TRANSFORMATION promises (verbs: Build, Structure, Master, Create).',
          '    • Delivery hosts (managed_service / lead_gen / saas / platform / product / unknown) → OUTCOME promises (verbs: Receive, Hit, Cut, Stop, Unlock, Get, Automate). Never use Build/Structure/Master for delivery hosts — their attendees do NOT build a system themselves.',
          '- The reader of the calendar invite is the prospect\'s CUSTOMER, not the prospect. Never frame the attendee as a sales target or describe their business model as if pitching them.',
          '- Anchor every claim and number to the brief. If unsupported, return null rather than fabricating.'
        ].join('\n');
    // Render each example as a JSON object matching the 12-field variant
    // schema Claude must produce. Demonstrations dominate over instructions,
    // so showing examples in the legacy Title+Description blob shape was the
    // single biggest signal teaching the model to emit `{hook, description,
    // for_line}` instead of the 12-field shape. Unparseable examples are
    // skipped (with a warn) rather than falling through to the legacy
    // rendering — better N−1 clean demonstrations than one dirty one.
    const renderedExamples = examples.map((ex, i) => {
      const title = ex.title || ex.label || '(untitled)';
      const parsed = parseExampleDescription(ex.description || ex.content || '');
      if (!parsed || !parsed.conditional_opener || !parsed.bullets || parsed.bullets.length < 3) {
        console.warn(`[copy-brain] example ${i+1} "${title}" failed to parse into 12-field shape (opener=${!!(parsed && parsed.conditional_opener)}, bullets=${parsed?.bullets?.length || 0}) — skipped`);
        return null;
      }
      // Build the demonstration object in the same key order as the system
      // prompt's Output Format. Drop nulls so the model doesn't learn that
      // `null` is acceptable for any field that's actually mandatory.
      const shown = { title };
      ['conditional_opener','proof_story','contrast_frame','session_promise','rsvp_block'].forEach(f => {
        if (parsed[f]) shown[f] = parsed[f];
      });
      if (parsed.bullets.length) shown.bullets = parsed.bullets;
      ['reframe_line','urgency_close','ps_replay','for_line'].forEach(f => {
        if (parsed[f]) shown[f] = parsed[f];
      });
      const note = parsed.for_line
        ? ''
        : '\n*(This example omits `for_line`, `variant`, `style`, and `_score` for brevity — they are still REQUIRED per the Output Format above.)*\n';
      return `### Calendar Example ${i + 1}${note}\n\`\`\`json\n${JSON.stringify(shown, null, 2)}\n\`\`\``;
    }).filter(Boolean);
    const examplesBlock = renderedExamples.length
      ? renderedExamples.join('\n\n---\n\n')
      : '(no parseable examples loaded — review `copy_brain_examples` rows; each must contain 💥 bullets, an "Instead of …" line, an "In this session…" line, and a "P.S." line)';
    return {
      business_context_block: (config.business_context && config.business_context.trim())
        ? config.business_context
        : '(no business context configured — edit in /settings → Copy Brain)',
      format_rules_block: (config.format_rules && config.format_rules.trim())
        ? config.format_rules
        : (WEBINAR_FALLBACK_FORMAT || '(use best-practice direct-response structure)'),
      principles_block: principlesBlock,
      examples_block: examplesBlock,
      _meta: {
        principles_count: principles.length,
        examples_count: examples.length,
        config_updated_at: config.updated_at || null,
        loaded_at: new Date().toISOString(),
      },
    };
  } catch (e) {
    console.warn('[copy-brain] load failed, using file-based fallback:', e.message);
    return {
      business_context_block: '(brain unreachable)',
      format_rules_block: WEBINAR_FALLBACK_FORMAT || '(use best-practice direct-response structure)',
      principles_block: '- Write as the prospect company hosting, never Quantum Scaling\n- Front-load ICP role in title first 40 chars\n- Every bullet is a transformation promise, not a topic',
      examples_block: '(none loaded)',
      _meta: {
        principles_count: 0,
        examples_count: 0,
        config_updated_at: null,
        loaded_at: new Date().toISOString(),
        fallback: true,
      },
    };
  }
}

// Upload file to Supabase Storage (bucket: sales-assets)
async function storageUpload(storagePath, content, contentType = 'text/html') {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${SUPABASE_URL}/storage/v1/object/sales-assets/${storagePath}`);
    const payload = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'PUT',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': contentType,
        'Content-Length': payload.length,
        'x-upsert': 'true'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/sales-assets/${storagePath}`;
          resolve(publicUrl);
        } else {
          reject(new Error(`Storage upload failed: ${res.statusCode} ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── DB helpers — jobs & tasks ─────────────────────────────────────────────────
async function createJob(email, websiteUrl, brief, repName = null, linkedinUrl = null) {
  // Website precedence: rep-entered → email domain (only if not free-mail).
  // Free-mail domains (gmail.com, yahoo.com, etc.) are explicitly excluded because
  // they tell us nothing about the prospect's company website.
  const emailDomain = (email || '').split('@')[1] || '';
  const fallbackDomain = isFreeMailDomain(emailDomain) ? null : emailDomain;
  const domain = websiteUrl || fallbackDomain;
  const prospectCompany = brief?.prospect?.company || null;
  const prospectName    = brief?.prospect?.contact_name || null;
  const r = await supabaseRequest('POST', '/rest/v1/jobs', {
    prospect_email:        email,
    prospect_website:      domain || null,
    prospect_company:      prospectCompany,
    prospect_name:         prospectName,
    prospect_linkedin_url: linkedinUrl || null,
    rep_name:              repName || null,      // B5 fix: persist rep at job creation
    extracted_data:        brief || null,
    status:                'processing'
  }, { 'Prefer': 'return=representation' });
  if (r.status >= 400) throw new Error(`createJob failed: ${r.status} ${JSON.stringify(r.body)}`);
  return Array.isArray(r.body) ? r.body[0] : r.body;
}

// Idempotent: unique constraint on (job_id, task_type) — duplicates silently ignored
async function createTasks(jobId, taskTypes) {
  const rows = taskTypes.map(t => ({
    job_id:        jobId,
    task_type:     t,
    status:        'pending',
    attempt_count: 0,
    max_attempts:  2
  }));
  const r = await supabaseRequest('POST', '/rest/v1/tasks', rows,
    { 'Prefer': 'return=representation,resolution=ignore-duplicates' });
  if (r.status >= 400) throw new Error(`createTasks failed: ${r.status}`);
  return Array.isArray(r.body) ? r.body : [r.body];
}

async function claimTask(taskId) {
  const r = await supabaseRequest('PATCH',
    `/rest/v1/tasks?id=eq.${taskId}&status=eq.pending`,
    { status: 'processing', started_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { 'Prefer': 'return=representation' }
  );
  if (r.status >= 400) return false;
  return Array.isArray(r.body) && r.body.length > 0;
}

async function completeTask(taskId, outputData, assetUrl) {
  await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${taskId}`, {
    status:       'completed',
    output_data:  outputData || null,
    asset_url:    assetUrl || null,
    completed_at: new Date().toISOString(),
    updated_at:   new Date().toISOString()
  });
}

// retryTask: increment attempt_count and reset to pending (up to max_attempts)
async function retryOrFailTask(task, errorMessage) {
  const attempts = (task.attempt_count || 0) + 1;
  if (attempts < (task.max_attempts || 2)) {
    console.log(`[worker] Retrying ${task.task_type} (attempt ${attempts}/${task.max_attempts})`);
    await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${task.id}`, {
      status:        'pending',
      attempt_count: attempts,
      error_message: `Attempt ${attempts} failed: ${errorMessage}`,
      started_at:    null,
      updated_at:    new Date().toISOString()
    });
  } else {
    await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${task.id}`, {
      status:        'failed',
      attempt_count: attempts,
      error_message: errorMessage,
      updated_at:    new Date().toISOString()
    });
  }
}

async function needsInputTask(taskId, errorMessage) {
  await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${taskId}`, {
    status:        'needs_input',
    error_message: errorMessage,
    updated_at:    new Date().toISOString()
  });
}

async function getJob(jobId) {
  const r = await supabaseRequest('GET', `/rest/v1/jobs?id=eq.${jobId}&limit=1`);
  if (r.status !== 200 || !Array.isArray(r.body) || !r.body.length) return null;
  return r.body[0];
}

async function updateJobExtractedData(jobId, extractedData) {
  await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`, {
    extracted_data: extractedData,
    updated_at:     new Date().toISOString()
  });
}

// Merge a worker-produced brief into a rep-confirmed one. Existing values
// (the brief the rep submitted via Step 2) WIN over fresh extraction for
// every field — the rep already confirmed those values, the worker shouldn't
// quietly clobber them when Claude happens to return null this pass.
//
// Exceptions:
//   - _meta: always fresh (worker stamps transcript + website source info).
//   - _provenance: union with existing winning per key — preserves the
//     transcript|inferred|missing tags the rep saw, but lets the worker fill
//     in tags for fields that didn't exist before.
//   - _generated, _overrides: untouched (those are managed elsewhere).
//
// Arrays are not deep-merged — existing wins entirely. Mixing arrays gets
// dicey (think apollo_titles, apollo_geography) and we'd rather keep the
// rep's curated list than auto-merge a Claude rerun into it.
function mergeBrief(existing, fresh) {
  if (!existing || typeof existing !== 'object') return fresh;
  if (!fresh    || typeof fresh    !== 'object') return existing;
  const out = { ...existing };
  for (const key of Object.keys(fresh)) {
    if (key === '_meta') { out[key] = fresh[key]; continue; }
    if (key === '_provenance') {
      out[key] = { ...(fresh[key] || {}), ...(existing[key] || {}) };
      continue;
    }
    if (key === '_generated' || key === '_overrides' || key === '_source') continue;
    const ev = existing[key];
    const fv = fresh[key];
    const isPlainObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
    if (ev == null || ev === '') {
      out[key] = fv;
    } else if (isPlainObj(ev) && isPlainObj(fv)) {
      out[key] = mergeBrief(ev, fv);
    } // else: existing scalar/array wins — keep it
  }
  return out;
}

async function updateJobBrandData(jobId, brandData) {
  await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`, {
    brand_data: brandData,
    updated_at: new Date().toISOString()
  });
}

async function updateJobResearchData(jobId, researchData) {
  await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`, {
    research_data: researchData,
    updated_at:    new Date().toISOString()
  });
}

async function updateJobStatus(jobId, status) {
  const patch = { status, updated_at: new Date().toISOString() };
  if (status === 'completed' || status === 'failed') patch.completed_at = new Date().toISOString();
  await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`, patch);
}

// ── Phase 4: In-app notification helper ───────────────────────────────────────
async function createNotification({ type, title, body = null, callId = null, jobId = null, repId = null }) {
  try {
    await supabaseRequest('POST', '/rest/v1/notifications',
      { type, title, body, call_id: callId, job_id: jobId, rep_id: repId, read: false },
      { 'Prefer': 'return=minimal', 'Content-Profile': 'public' }
    );
  } catch(e) {
    console.warn('[notif] Failed to create notification:', e.message);
  }
}

async function getTasksByJobId(jobId) {
  const r = await supabaseRequest('GET', `/rest/v1/tasks?job_id=eq.${jobId}&order=created_at.asc`);
  if (r.status !== 200) return [];
  return Array.isArray(r.body) ? r.body : [];
}

async function getRecentJobsByEmail(email, limit = 5) {
  const r = await supabaseRequest(
    'GET',
    `/rest/v1/jobs?prospect_email=eq.${encodeURIComponent(email)}&order=updated_at.desc&limit=${limit}`
  );
  if (r.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body;
}

// Build a Map<apollo_id, enriched_lead> from this prospect's previous jobs.
// Used by lead_list + rerun-apollo to skip the people/match Apollo call (1
// credit per lead) when the same lead was already enriched on an earlier run
// for the same prospect_email. We only seed from rows where `revealed === true`
// — those are the leads that actually had a successful Apollo match.
async function getCachedApolloEnrichments(email, currentJobId = null) {
  if (!email) return new Map();
  // Scan the last 20 jobs for this prospect — enough to cover months of reruns
  // without scanning the whole table. Skip the current job to avoid pulling
  // half-written state during rerun-apollo.
  const r = await supabaseRequest(
    'GET',
    `/rest/v1/jobs?prospect_email=eq.${encodeURIComponent(email)}&select=id,extracted_data&order=updated_at.desc&limit=20`
  );
  if (r.status !== 200 || !Array.isArray(r.body)) return new Map();
  const cache = new Map();
  for (const row of r.body) {
    if (currentJobId && row.id === currentJobId) continue;
    const leads = row.extracted_data?._generated?.leads;
    if (!Array.isArray(leads)) continue;
    for (const l of leads) {
      if (!l || !l.apollo_id || !l.revealed) continue;
      if (cache.has(l.apollo_id)) continue; // first (newest) wins
      cache.set(l.apollo_id, {
        name:         l.name || null,
        email:        l.email || null,
        company_size: l.company_size || null,
        website:      l.website || null,
        linkedin_url: l.linkedin_url || null,
        photo_url:    l.photo_url || null,
        headline:     l.headline || null
      });
    }
  }
  return cache;
}

async function getPendingTasks(limit = 5) {
  const r = await supabaseRequest('GET', `/rest/v1/tasks?status=eq.pending&order=created_at.asc&limit=${limit}`);
  if (r.status !== 200) return [];
  return Array.isArray(r.body) ? r.body : [];
}

async function getTaskOutput(jobId, taskType) {
  const r = await supabaseRequest('GET',
    `/rest/v1/tasks?job_id=eq.${jobId}&task_type=eq.${taskType}&limit=1`);
  if (r.status !== 200 || !Array.isArray(r.body) || !r.body.length) return null;
  return r.body[0];
}

// ── Utility ───────────────────────────────────────────────────────────────────
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch(e) { resolve({}); } });
    req.on('error', reject);
  });
}
// Binary-safe body reader. Streams chunks into a Buffer and rejects once the
// running total crosses maxBytes — protects against huge uploads slipping past
// reverse-proxy limits. Used by the rep asset-upload endpoint.
async function parseBinaryBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        req.destroy();
        return reject(new Error(`Request body exceeded ${maxBytes} bytes`));
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Apify helper ──────────────────────────────────────────────────────────────
async function runApifyActor(actorId, input, timeoutMs = 90000) {
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_TOKEN) throw new Error('APIFY_API_TOKEN not set');

  // Start the run
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15000)
    }
  );
  if (!startRes.ok) {
    const text = await startRes.text();
    if (startRes.status === 401) throw new Error('Apify 401: invalid token');
    throw new Error(`Apify start failed: ${startRes.status} ${text.slice(0, 200)}`);
  }
  const startData = await startRes.json();
  const runId = startData.data?.id;
  const datasetId = startData.data?.defaultDatasetId;
  if (!runId) throw new Error('Apify: no run ID returned');

  // Poll for completion
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!pollRes.ok) continue;
    const pollData = await pollRes.json();
    const status = pollData.data?.status;
    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run ${status}: ${runId}`);
    }
  }

  if (Date.now() >= deadline) throw new Error('Apify actor timeout');

  // Fetch results
  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!itemsRes.ok) throw new Error(`Apify dataset fetch failed: ${itemsRes.status}`);
  return await itemsRes.json();
}

// ── GHL contact lookup ────────────────────────────────────────────────────────
const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

async function lookupGHLContact(email) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    console.log('[GHL] No credentials — skipping contact lookup');
    return null;
  }
  try {
    // GHL v2 — /contacts/search/duplicate is the canonical "find one contact by
    // email" endpoint. The older /contacts/?email=… returns 422 ("property email
    // should not exist") on the v2 API as of 2026-05.
    const url = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) { console.warn('[GHL] Lookup failed:', res.status); return null; }
    const data = await res.json();
    const contact = data.contact;
    if (!contact) return null;
    const trim = (s) => typeof s === 'string' ? s.trim() : s;
    const name = [trim(contact.firstName), trim(contact.lastName)].filter(Boolean).join(' ').trim() || null;
    const company = trim(contact.companyName) || trim(contact.company) || null;
    const website = trim(contact.website) || null;
    // Custom fields on the v2 duplicate endpoint don't carry the field NAME (only
    // the location-specific field ID). Resolving IDs → names requires a separate
    // call to /locations/{id}/customFields. Cheap pattern-match works for the
    // one field we actually need here: a LinkedIn URL is recognisable by value.
    const customFields = contact.customField || contact.customFields || [];
    let linkedinUrl = null;
    for (const f of customFields) {
      const v = f.value || f.fieldValue || f.fieldValueString || '';
      if (typeof v === 'string' && /linkedin\.com\/(in|company)\//i.test(v)) {
        linkedinUrl = v.trim();
        break;
      }
    }
    // assignedTo carries the GHL user ID of the rep who owns this contact.
    // Some GHL tenants only surface it on GET /contacts/:id, so accept a
    // second-level fallback by reading `assigned` (older shape) too.
    const ghlUserId = contact.assignedTo || contact.assigned_to || contact.assigned || null;
    console.log(`[GHL] Found contact: ${name} @ ${company}${linkedinUrl ? ' (LinkedIn ✓)' : ''}${ghlUserId ? ` (assignedTo=${ghlUserId})` : ''}`);
    return {
      id: contact.id || null,   // needed to query this contact's opportunities
      name, company, website, title: null, linkedin_url: linkedinUrl,
      ghl_user_id: ghlUserId
    };
  } catch(e) {
    console.warn('[GHL] Lookup error:', e.message);
    return null;
  }
}

// ── GHL opportunity owner lookup ─────────────────────────────────────────────
// Reps care about the OPPORTUNITY owner, not the contact owner — in GHL those
// can diverge (intake auto-assigns the contact to a default user, then the
// deal moves to whichever rep is actively working it). We pick the most
// recently updated opportunity and return its assignedTo user ID. Falls back
// to null if the contact has no opportunities yet.
async function lookupGHLOpportunityOwner(contactId) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID || !contactId) return null;
  try {
    const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${encodeURIComponent(contactId)}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) { console.warn('[GHL/opp] Lookup failed:', res.status); return null; }
    const data = await res.json();
    const opps = Array.isArray(data.opportunities) ? data.opportunities : [];
    if (!opps.length) return null;
    // Most recently updated first (active pipeline deals tend to sit at the top).
    opps.sort((a, b) => new Date(b.updatedAt || b.dateUpdated || 0) - new Date(a.updatedAt || a.dateUpdated || 0));
    const top = opps[0];
    const owner = top.assignedTo || top.assigned_to || top.assigned || null;
    console.log(`[GHL/opp] contact ${String(contactId).slice(0,8)} → ${opps.length} opps, top "${top.name || top.title || top.id}" assignedTo=${owner || 'unassigned'}`);
    return owner ? { ghl_user_id: owner, opportunity_id: top.id, opportunity_name: top.name || null } : null;
  } catch(e) {
    console.warn('[GHL/opp] error:', e.message);
    return null;
  }
}

// ── Sales rep lookup (GHL user ID → app rep slug) ────────────────────────────
// sales_assets.sales_reps maps GHL `assignedTo` IDs to the rep slugs the app
// already uses ('melissa' | 'ryan' | 'armando'). Cached for 5 minutes so the
// prefetch flow doesn't pay a Supabase round-trip per request.
let _repCache = { rows: null, fetchedAt: 0 };
const REP_CACHE_TTL = 5 * 60 * 1000;

async function loadActiveReps() {
  const fresh = _repCache.rows && (Date.now() - _repCache.fetchedAt < REP_CACHE_TTL);
  if (fresh) return _repCache.rows;
  try {
    // SELECT * so any new columns (e.g. `email` for speaker matching in
    // Fireflies transcripts) become available without a code redeploy —
    // operators can add the column via Supabase UI and populate it.
    const r = await supabaseRequest('GET',
      '/rest/v1/sales_reps?select=*');
    if (r.status === 200 && Array.isArray(r.body)) {
      _repCache = { rows: r.body, fetchedAt: Date.now() };
    } else {
      console.warn('[sales_reps] load failed:', r.status, JSON.stringify(r.body).slice(0, 200));
      _repCache = { rows: [], fetchedAt: Date.now() };
    }
  } catch(e) {
    console.warn('[sales_reps] load error:', e.message);
    _repCache = { rows: [], fetchedAt: Date.now() };
  }
  return _repCache.rows;
}

async function getRepByGhlUserId(ghlUserId) {
  if (!ghlUserId) return null;
  const rows = await loadActiveReps();
  return rows.find(r => r.active && r.ghl_user_id === ghlUserId) || null;
}

async function getRepBySlug(slug) {
  if (!slug) return null;
  const rows = await loadActiveReps();
  return rows.find(r => r.active && r.slug === slug) || null;
}

// ── Sync sales_reps.email from GHL ────────────────────────────────────────────
// Source of truth for QS rep emails is GHL — each rep already has a
// ghl_user_id in sales_reps. This pulls the corresponding email (and refreshes
// display_name) from GHL's /users/ endpoint and writes it back. Used by the
// /api/admin/sync-rep-emails admin endpoint AND fired automatically at boot
// when any active rep is missing an email. The synced email then flows into
// getRepEmails() → _annotateTranscript() so Fireflies transcript turns get
// labeled [REP] vs [PROSPECT] correctly.
//
// Requires a one-time schema migration (Supabase SQL editor):
//   ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS email TEXT;
async function syncRepEmailsFromGHL() {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    return { ok: false, error: 'GHL_API_KEY / GHL_LOCATION_ID not set', synced: 0, missing: 0 };
  }
  // 1. Fetch all GHL users in this location.
  let ghlUsers = [];
  try {
    const r = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${GHL_LOCATION_ID}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      return { ok: false, error: `GHL /users returned ${r.status}`, synced: 0, missing: 0 };
    }
    const data = await r.json();
    ghlUsers = data.users || [];
  } catch (e) {
    return { ok: false, error: 'GHL /users fetch failed: ' + e.message, synced: 0, missing: 0 };
  }
  const byId = new Map(ghlUsers.map(u => [u.id, u]));

  // 2. Load every sales_rep row (active and inactive — we want to keep
  // historical rep records in sync too in case they're reactivated).
  const repsResp = await supabaseRequest('GET', '/rest/v1/sales_reps?select=*');
  if (repsResp.status !== 200 || !Array.isArray(repsResp.body)) {
    return { ok: false, error: `Supabase load failed: ${repsResp.status}`, synced: 0, missing: 0 };
  }
  const reps = repsResp.body;

  // 3. For each rep with a ghl_user_id, compare the cached email to GHL's
  // current email. PATCH only when there's a real diff to avoid noisy writes.
  let synced = 0;
  let missing = 0;
  const stillMissing = [];
  for (const rep of reps) {
    if (!rep.ghl_user_id) continue;
    const ghlUser = byId.get(rep.ghl_user_id);
    if (!ghlUser) {
      // Rep linked to a GHL user that no longer exists in this location.
      if (!rep.email) { missing++; stillMissing.push({ slug: rep.slug, ghl_user_id: rep.ghl_user_id, reason: 'ghl_user_not_found' }); }
      continue;
    }
    const ghlEmail = String(ghlUser.email || '').trim().toLowerCase();
    if (!ghlEmail) {
      if (!rep.email) { missing++; stillMissing.push({ slug: rep.slug, ghl_user_id: rep.ghl_user_id, reason: 'ghl_user_has_no_email' }); }
      continue;
    }
    const ghlName = [ghlUser.firstName, ghlUser.lastName].filter(Boolean).join(' ').trim()
                    || ghlUser.name || rep.display_name || null;
    const currentEmail = String(rep.email || '').trim().toLowerCase();
    const patch = {};
    if (currentEmail !== ghlEmail) patch.email = ghlEmail;
    // Refresh display_name only when GHL has a non-empty name AND it differs.
    if (ghlName && rep.display_name !== ghlName) patch.display_name = ghlName;
    if (Object.keys(patch).length === 0) continue;
    // PATCH by whichever primary-key-shaped column the row actually has. If a
    // deployment ever changes the PK we surface the actual Supabase error body
    // through the response so the cause is debuggable from the curl output
    // instead of being hidden behind a generic message.
    try {
      const pkColumn = rep.id ? 'id' : (rep.ghl_user_id ? 'ghl_user_id' : 'slug');
      const pkValue  = rep[pkColumn];
      const pr = await supabaseRequest('PATCH', `/rest/v1/sales_reps?${pkColumn}=eq.${encodeURIComponent(pkValue)}`,
        patch, { 'Prefer': 'return=minimal' });
      if (pr.status >= 400) {
        const bodyStr = (typeof pr.body === 'string') ? pr.body : JSON.stringify(pr.body);
        console.warn(`[sync-reps] PATCH failed rep=${rep.slug || rep.id} pk=${pkColumn}=${pkValue} status=${pr.status} body=${bodyStr.slice(0, 500)}`);
        return {
          ok: false,
          error: `Supabase PATCH ${pr.status} for rep ${rep.slug || pkValue}: ${bodyStr.slice(0, 400)}`,
          patch_payload: patch,
          pk_used: { column: pkColumn, value: pkValue },
          rep_columns_seen: Object.keys(rep),
          synced,
          missing
        };
      }
      synced++;
    } catch (e) {
      console.warn(`[sync-reps] PATCH error for rep ${rep.slug || rep.id}: ${e.message}`);
    }
  }

  // 4. Bust the in-memory cache so getRepEmails() picks up the new values on
  // its next call without waiting out the 5-minute TTL.
  _repCache = { rows: null, fetchedAt: 0 };

  console.log(`[sync-reps] Synced ${synced} rep email/name updates from GHL · ${missing} still missing`);
  return { ok: true, synced, missing, still_missing: stillMissing, ghl_users_seen: ghlUsers.length, sales_reps_seen: reps.length };
}

// ── Speaker-role identification for Fireflies transcripts ─────────────────────
// Returns a lowercased Set of known QS rep email addresses, used to tag each
// transcript turn as [REP] or [PROSPECT] before the brief extractor sees it.
// Primary source: sales_reps.email column — populated automatically from GHL
// by syncRepEmailsFromGHL() (boot-time auto-sync + /api/admin/sync-rep-emails
// endpoint). Falls back to QS_REP_EMAILS env var (comma-separated) for ops
// who'd rather not lean on the DB sync path.
async function getRepEmails() {
  const out = new Set();
  (process.env.QS_REP_EMAILS || '').split(',').forEach(e => {
    const v = String(e || '').trim().toLowerCase();
    if (v && v.includes('@')) out.add(v);
  });
  try {
    const reps = await loadActiveReps();
    reps.forEach(r => {
      const fields = [r.email, r.work_email, r.primary_email];
      fields.forEach(f => {
        const v = String(f || '').trim().toLowerCase();
        if (v && v.includes('@')) out.add(v);
      });
      // Aliases column (jsonb array or comma string) if operators set it up.
      const aliases = Array.isArray(r.email_aliases)
        ? r.email_aliases
        : (typeof r.email_aliases === 'string' ? r.email_aliases.split(',') : []);
      aliases.forEach(a => {
        const v = String(a || '').trim().toLowerCase();
        if (v && v.includes('@')) out.add(v);
      });
    });
  } catch (_) { /* loadActiveReps already logs */ }
  return out;
}

// Build a labeled transcript string from raw Fireflies sentences + attendees.
// Each turn is prefixed [REP] / [PROSPECT] / [SPEAKER] based on speaker_name →
// attendee.email → rep-email lookup. Falls back to plain "Name: text" when no
// match is possible (so the extractor still gets the verbatim words).
//
// Why this matters: Call 1 transcripts are dominated by the rep pitching QS's
// methodology. Without speaker labels, the extractor's strongest signal for
// "result delivered" is often the rep's PITCH, not the prospect's actual
// product — producing webinar copy that describes QS's offer instead of the
// prospect's. Labels let the extract prompt source prospect-side fields from
// [PROSPECT] turns only and treat [REP] turns as context.
function _annotateTranscript(sentences, attendees, repEmailSet) {
  if (!Array.isArray(sentences) || sentences.length === 0) return { text: '', labeled: false, counts: { rep: 0, prospect: 0, unknown: 0 } };
  // Build name → email map from attendees (case-insensitive, whitespace-trimmed).
  const nameToEmail = new Map();
  const firstNameToEmail = new Map();
  (attendees || []).forEach(a => {
    const dn = String(a?.displayName || a?.display_name || '').trim().toLowerCase();
    const em = String(a?.email || '').trim().toLowerCase();
    if (!dn) return;
    if (em) nameToEmail.set(dn, em);
    const first = dn.split(/\s+/)[0];
    if (first && em && !firstNameToEmail.has(first)) firstNameToEmail.set(first, em);
  });
  const reps = repEmailSet || new Set();
  let rep = 0, prospect = 0, unknown = 0;
  const classify = (speakerName) => {
    const key = String(speakerName || '').trim().toLowerCase();
    if (!key) { unknown++; return 'SPEAKER'; }
    let email = nameToEmail.get(key);
    if (!email) {
      const first = key.split(/\s+/)[0];
      email = firstNameToEmail.get(first);
    }
    if (!email) { unknown++; return 'SPEAKER'; }
    if (reps.has(email)) { rep++; return 'REP'; }
    prospect++;
    return 'PROSPECT';
  };
  const lines = sentences
    .filter(s => s && s.text && String(s.text).trim().length > 0)
    .map(s => {
      const role = classify(s.speaker_name);
      const name = s.speaker_name || 'Speaker';
      return `[${role}] ${name}: ${String(s.text).trim()}`;
    });
  const labeled = (rep + prospect) > 0;
  return { text: lines.join('\n'), labeled, counts: { rep, prospect, unknown } };
}

function invalidateRepCache() { _repCache = { rows: null, fetchedAt: 0 }; }

// Apollo people/match by email — used as a fallback when GHL has no contact data.
// Returns { linkedin_url, headshot_url, title, name, company } or null. Best-effort,
// 1 Apollo credit per call. Times out at 8s so the prefetch flow never hangs.
async function apolloMatchByEmail(email) {
  const apolloKey = process.env.APOLLO_API_KEY;
  if (!apolloKey || !email) return null;
  try {
    const r = await fetch('https://api.apollo.io/api/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apolloKey },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) { console.warn('[Apollo match] HTTP', r.status); return null; }
    const data = await r.json();
    const p = data.person || {};
    const name = (p.first_name && p.last_name) ? `${p.first_name} ${p.last_name}`.trim() : (p.name || null);
    const company = (p.organization && p.organization.name) || p.organization_name || null;
    return {
      linkedin_url: p.linkedin_url || null,
      headshot_url: p.photo_url || null,
      title:        p.title || null,
      name:         name,
      company:      company
    };
  } catch(e) {
    console.warn('[Apollo match] error:', e.message);
    return null;
  }
}

// Extract a clean company name from a scraped <title> tag.
// Strips common suffix separators ('|', '–', '—', '-', ':') so
// "The 4FP Agency | Financial Planners" → "The 4FP Agency".
function companyFromWebsiteTitle(title) {
  if (!title || typeof title !== 'string') return null;
  const segments = title.split(/\s*[|–—\-:]\s*/);
  const first = segments[0]?.trim();
  if (!first || first.length < 2 || first.length > 60) return null;
  // Filter obvious non-companies (homepage labels, etc.)
  if (/^(home|welcome|index|untitled|page not found)$/i.test(first)) return null;
  return first;
}

// Free-mail providers — when an email lives on one of these, the email domain is
// not a reliable signal for the prospect's company website.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','aol.com',
  'me.com','live.com','msn.com','protonmail.com','proton.me','gmx.com',
  'yandex.com','mail.com','zoho.com','fastmail.com','pm.me'
]);
function isFreeMailDomain(domain) {
  return FREE_MAIL_DOMAINS.has(String(domain || '').toLowerCase().trim());
}

// Normalize a website candidate from any source (GHL, history, email_domain,
// rep input). Returns null if the value is empty, a protocol-only string, or
// a free-mail domain — those are never the prospect's actual website. We saw
// GHL records auto-fill `website = outlook.com` from the contact's email,
// which then propagated through Step 1 as a misleading suggestion.
function cleanWebsiteCandidate(raw) {
  if (!raw) return null;
  const host = String(raw).trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  if (!host || host === 'http:' || host === 'https:') return null;
  if (isFreeMailDomain(host)) return null;
  return host;
}

// "Does this work-email domain match this company name?" — used to validate or
// fill the Website column from a contact's email when the proxy scrape didn't
// find a good URL (or returned something off-target like fca.org.uk for
// "Millennium Financial Group"). Loose substring match in both directions,
// after stripping common business-suffix tokens. Free-mail domains short-
// circuit to false — gmail tells us nothing about the company.
const _COMPANY_NAME_STOPWORDS = new Set([
  'the','and','of','llc','inc','ltd','corp','corporation','company','co',
  'group','holdings','holding','partners','partner','services','service',
  'associates','enterprises','agency','solutions','consulting','financial'
]);
function emailDomainMatchesCompany(emailDomain, companyName) {
  if (!emailDomain || !companyName) return false;
  emailDomain = String(emailDomain).toLowerCase().trim();
  if (isFreeMailDomain(emailDomain)) return false;
  // Domain core = registrable label (microsoft.com → "microsoft",
  // arrowrootfamilyoffice.com → "arrowrootfamilyoffice"). Subdomains stripped
  // by taking the first label before the dot.
  const domainCore = emailDomain.split('.')[0].replace(/[^a-z0-9]/g, '');
  if (domainCore.length < 3) return false;
  // Significant company tokens: ≥4 chars, not a generic business suffix.
  const tokens = normalizeToken(companyName).split(/\s+/)
    .filter(t => t.length >= 4 && !_COMPANY_NAME_STOPWORDS.has(t));
  if (!tokens.length) return false;
  return tokens.some(t => domainCore.includes(t) || t.includes(domainCore));
}

function normalizeToken(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function uniqueTokens(values, minLength = 3) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    for (const token of normalizeToken(value).split(/\s+/)) {
      if (!token || token.length < minLength) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

// ── Fireflies GraphQL helper ──────────────────────────────────────────────────
async function firefliesQuery(gql, variables) {
  const res = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.FIREFLIES_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: gql, variables }),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) { console.error('Fireflies HTTP error:', res.status); return null; }
  const data = await res.json();
  if (data.errors) { console.error('Fireflies errors:', JSON.stringify(data.errors)); return null; }
  return data.data;
}

// Used in search/list passes — NO sentences (would be enormous for 30-50 transcripts)
const TRANSCRIPT_LIST_FIELDS = `
  id title dateString duration
  summary { short_summary overview action_items shorthand_bullet }
  meeting_attendees { email displayName }
`;

// Used for single-transcript detail fetch after match is found
const TRANSCRIPT_DETAIL_FIELDS = `
  id title dateString duration
  summary { short_summary overview action_items shorthand_bullet }
  sentences { text speaker_name }
  meeting_attendees { email displayName }
`;

// Fetch a single transcript by ID to get full sentences (called after match is confirmed)
async function fetchTranscriptDetail(id) {
  try {
    const gql  = `query Detail($id: String!) { transcript(id: $id) { ${TRANSCRIPT_DETAIL_FIELDS} } }`;
    const data = await firefliesQuery(gql, { id });
    return data?.transcript || null;
  } catch(e) {
    console.warn('[FF] Detail fetch failed for', id, ':', e.message);
    return null;
  }
}

// B2 fix: Multi-transcript search — returns ALL calls matching this prospect.
// The caller (handleExtract) aggregates all summaries into one Claude context block
// so that follow-up calls, pricing calls, and objection-handling calls all inform the ICP.
// Sort order: exact-email matches first, then by duration desc (longest = richest context).
async function findFirefliesTranscripts(email, contactInfo = {}) {
  const domain     = (email.split('@')[1] || '').toLowerCase();
  const domainBase = domain.split('.')[0];
  const emailLocal = email.split('@')[0].toLowerCase();
  const NON_GENERIC    = new Set(['info','admin','contact','hello','sales','support','team','office','mail','noreply','no-reply','hi','hey']);
  const GENERIC_DOMAINS = new Set(['gmail','yahoo','hotmail','outlook','icloud','proton','me','live','aol']);
  const nameTokens = uniqueTokens([contactInfo.name]);
  const companyTokens = uniqueTokens([contactInfo.company, domainBase], 4);

  // ── Build ordered search terms: best signal first ───────────────────────────
  const terms = []; // { keyword, source, acceptLoose }

  // A) GHL contact first + last name (highest quality)
  const fullName = (contactInfo.name || '').trim();
  if (fullName) {
    const parts = fullName.split(/\s+/);
    const fn = parts[0]?.toLowerCase();
    const ln = parts[parts.length - 1]?.toLowerCase();
    if (fn && fn.length >= 3) terms.push({ keyword: fn, source: 'ghl_first', acceptLoose: false });
    if (ln && ln !== fn && ln.length >= 3) terms.push({ keyword: ln, source: 'ghl_last', acceptLoose: false });
  }

  // B) GHL company name + first word of company
  const company = (contactInfo.company || '').trim();
  if (company.length >= 3) {
    terms.push({ keyword: company.toLowerCase(), source: 'ghl_company', acceptLoose: true });
    const compWord = company.split(/[\s,._\-]+/)[0].toLowerCase();
    if (compWord.length >= 4 && compWord !== company.toLowerCase()) {
      terms.push({ keyword: compWord, source: 'ghl_company_word', acceptLoose: true });
    }
  }

  // C) All email local-part segments (sgoldstucker → ['sgoldstucker']; sarah.goldstucker → ['sarah','goldstucker'])
  // acceptLoose=true for segments >= 7 chars — specific enough that Fireflies finding it means it's the right transcript
  for (const part of emailLocal.split(/[._\-+]/)) {
    const clean = part.replace(/\d+$/, '');
    if (/^[a-z]{3,20}$/.test(clean) && !NON_GENERIC.has(clean) && clean !== domainBase) {
      terms.push({ keyword: clean, source: `email:${clean}`, acceptLoose: clean.length >= 7 });
    }
  }

  // D) Domain base — accept loose match (Fireflies often omits attendee emails)
  if (domainBase.length >= 4 && !GENERIC_DOMAINS.has(domainBase)) {
    terms.push({ keyword: domainBase, source: 'domain', acceptLoose: true });
  }

  // ── Match helpers ─────────────────────────────────────────────────────────
  const isExactEmail  = t => (t.meeting_attendees || []).some(a => (a.email || '').toLowerCase() === email.toLowerCase());
  const isDomainEmail = t => (t.meeting_attendees || []).some(a => (a.email || '').toLowerCase().endsWith('@' + domain));
  const hasDisplayNameMatch = t => {
    if (!nameTokens.length) return false;
    return (t.meeting_attendees || []).some(a => {
      const normalized = normalizeToken(a.displayName);
      return nameTokens.every(token => normalized.includes(token)) ||
        nameTokens.some(token => normalized.includes(token));
    });
  };
  const hasCompanyTitleMatch = t => {
    const haystack = normalizeToken(t.title);
    if (!haystack) return false;
    return companyTokens.some(token => haystack.includes(token));
  };

  // Collect ALL unique matches into a Map (id → transcript)
  const allMatches = new Map();
  function collectMatches(results, acceptLoose, source) {
    results.filter(isExactEmail).forEach(t => {
      if (!allMatches.has(t.id)) { console.log(`[FF] ✓ exact email (${source}): "${t.title}"`); allMatches.set(t.id, t); }
    });
    results.filter(isDomainEmail).forEach(t => {
      if (!allMatches.has(t.id)) { console.log(`[FF] ✓ domain email (${source}): "${t.title}"`); allMatches.set(t.id, t); }
    });
    if (acceptLoose) results.forEach(t => {
      if (!allMatches.has(t.id)) { console.log(`[FF] ✓ loose match (${source}): "${t.title}"`); allMatches.set(t.id, t); }
    });
  }

  // ── Passes 1–6b: fan out all 7 Fireflies queries in parallel ──────────────
  // The previous sequential loop spent ~3-5s on Fireflies because each pass
  // awaited the network round-trip before starting the next. The picker UI
  // wants to render candidates as fast as possible — Promise.allSettled keeps
  // a single slow pass from blocking everyone else, and a per-pass try/catch
  // is no longer needed since allSettled wraps each rejection.
  const searchGql = `query Search($keyword: String) { transcripts(keyword: $keyword, limit: 30) { ${TRANSCRIPT_LIST_FIELDS} } }`;
  const seen = new Set();
  const passes = [];
  for (const t of terms) {
    if (seen.has(t.keyword)) continue;
    seen.add(t.keyword);
    passes.push({ source: t.source, acceptLoose: t.acceptLoose, promise: firefliesQuery(searchGql, { keyword: t.keyword }) });
  }
  passes.push({
    source: 'recent_scan_6a', acceptLoose: false,
    promise: firefliesQuery(`{ transcripts(limit: 50) { ${TRANSCRIPT_LIST_FIELDS} } }`, {})
  });
  passes.push({
    source: 'recent_scan_6b', acceptLoose: false,
    promise: firefliesQuery(`{ transcripts(limit: 50, skip: 50) { ${TRANSCRIPT_LIST_FIELDS} } }`, {})
  });

  const settled = await Promise.allSettled(passes.map(p => p.promise));
  settled.forEach((r, i) => {
    const p = passes[i];
    if (r.status === 'fulfilled') {
      const transcripts = r.value?.transcripts || [];
      if (p.source.startsWith('recent_scan_')) {
        console.log(`[FF] ${p.source}: ${transcripts.length} transcripts`);
      }
      collectMatches(transcripts, p.acceptLoose, p.source);
    } else {
      console.warn(`[FF] Pass ${p.source} error:`, r.reason?.message || r.reason);
    }
  });
  // Keep the `searched` log shape the empty-match branch expects below.
  const searched = seen;

  // ── Sort and return all matches ────────────────────────────────────────────
  const matches = [...allMatches.values()];
  if (!matches.length) {
    console.log('[FF] No transcripts found for', email, '— searched:', [...searched].join(', '));
    return [];
  }
  // Tag each match with how it qualified (exact_email > domain > loose). The
  // picker UI in calls.html / mockup-dashboard.html color-codes rows by this
  // so the rep can tell at a glance which candidate is the strongest link.
  matches.forEach(t => {
    t._match_kind = isExactEmail(t) ? 'exact_email'
                  : isDomainEmail(t) ? 'domain'
                  : 'loose';
  });
  // Exact email first, then longest duration (most context)
  matches.sort((a, b) => {
    const aEx = isExactEmail(a) ? 1 : 0, bEx = isExactEmail(b) ? 1 : 0;
    if (bEx !== aEx) return bEx - aEx;
    return (b.duration || 0) - (a.duration || 0);
  });
  console.log(`[FF] Found ${matches.length} transcript(s) for ${email}:`);
  matches.forEach(t => console.log(`[FF]   - "${t.title}" (${(t.duration||0).toFixed(0)} min) [${t._match_kind}]`));
  return matches;
}

// Legacy wrapper — callers that need only the best single transcript
async function findFirefliesTranscript(email, contactInfo = {}) {
  const all = await findFirefliesTranscripts(email, contactInfo);
  return all[0] || null;
}

// ── Website scraper ───────────────────────────────────────────────────────────
async function scrapeWebsite(domain) {
  // Strip protocol if accidentally passed with it
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const baseUrl = `https://${cleanDomain}`;

  // ── Path A: Jina AI Reader — renders JS/SPA sites via headless browser ──────
  // Returns clean markdown text — far better than regex-stripped HTML for briefs.
  // No API key required. Already proven in websiteQualityCheck() for lead classification.
  const jinaFetch = async (targetUrl) => {
    try {
      const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-Timeout': '8' },
        signal: AbortSignal.timeout(9000)
      });
      if (!res.ok) return '';
      return (await res.text()).trim();
    } catch(e) { return ''; }
  };

  // ── Path B: Raw HTML — needed for <title>, og:image, theme-color, and the
  // logo/color regex extraction in brand_scrape. Try the site directly first;
  // if the host blocks our outbound IP or returns < 500 chars (typical of WAF
  // block pages and JS-only SPAs), fall back to corsproxy.io which rotates
  // the outbound IP. The proxy is best-effort: if CORSPROXY_API_KEY isn't
  // configured, we skip it silently.
  const directHtml = async () => {
    try {
      const res = await fetch(baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(8000)
      });
      return res.ok ? await res.text() : '';
    } catch(e) { return ''; }
  };
  const proxyHtml = async () => {
    const proxyKey = process.env.CORSPROXY_API_KEY;
    if (!proxyKey) return '';
    try {
      const url = 'https://corsproxy.io/?key=' + encodeURIComponent(proxyKey)
                + '&url=' + encodeURIComponent(baseUrl);
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      return res.ok ? await res.text() : '';
    } catch(e) { return ''; }
  };

  // Run Jina (text path) and direct HTML in parallel — typical-case latency.
  const [jinaText, directHtmlText] = await Promise.all([jinaFetch(baseUrl), directHtml()]);
  let html = directHtmlText;
  let htmlSource = directHtmlText.length >= 500 ? 'direct' : null;
  // If the direct fetch was empty or suspiciously short (block page / SPA shell),
  // retry via the proxy. This is the "Direct fetch, fallback proxy fetch" path.
  if (!htmlSource) {
    const proxied = await proxyHtml();
    if (proxied.length >= 500) { html = proxied; htmlSource = 'proxy'; }
    else if (proxied.length > html.length) { html = proxied; htmlSource = 'proxy_short'; }
    else if (!html) { htmlSource = 'none'; }
    else { htmlSource = 'direct_short'; }
  }

  // If Jina homepage is thin (<250 chars), try /about page for richer content
  let bodyText = jinaText;
  if (jinaText.length < 250) {
    const aboutText = await jinaFetch(`${baseUrl}/about`);
    if (aboutText.length > jinaText.length) bodyText = aboutText;
  }
  bodyText = bodyText.slice(0, 3000);

  // Extract title + metaDesc from raw HTML (they're in <head>, always server-rendered)
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]?.trim() ||
                bodyText.split('\n').find(l => l.trim().length > 10)?.trim().slice(0, 120) || '';
  const metaDesc = (
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})/i) ||
    html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i)
  )?.[1]?.trim() || '';

  console.log(`[scrape] ${cleanDomain} — Jina:${jinaText.length}chars, HTML:${html.length}chars (${htmlSource}), title:"${title.slice(0,60)}"`);
  return { html, title, metaDesc, bodyText, html_source: htmlSource };
}

// ── Brief extraction from transcript + website ────────────────────────────────
async function extractBriefFromTranscript(transcriptContent, websiteContent, contactInfo) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const knownCompany  = contactInfo.company  || null;
  const knownName     = contactInfo.name     || null;
  const knownWebsite  = contactInfo.website  || null;

  const systemPrompt = `You are extracting a high-fidelity Prospect Brief from a sales call transcript.
Your job is to pull out the richest possible context for creating personalized sales assets.

Rules:
- Extract ONLY what was explicitly stated. Return null for anything not mentioned.
- Never infer, guess, or hallucinate values — with two narrow exceptions noted below.
- The PROSPECT is the CLIENT company being pitched to — NOT Quantum Scaling, NOT Lloyd Yip, NOT QS team.
- For verbatim fields: copy exact words spoken. Do not paraphrase.
- For apollo_titles: return ONLY real job titles (2-4 words each) that a person would hold on LinkedIn or a business card. These feed directly into an API search. Sentence fragments, role descriptions, and qualifiers are NEVER valid titles — infer the actual titles from the described role.

SPEAKER LABELS (when the transcript header announces them):
- [REP] = a Quantum Scaling sales rep (the SELLER, pitching their service to the prospect).
- [PROSPECT] = the buyer being pitched (the prospect company, your subject).
- [SPEAKER] = unknown role — could be either; treat as low-trust.

If the transcript is labeled, these fields MUST be sourced ONLY from [PROSPECT] turns:
- prospect.offer_description, prospect.offering_name
- angle.pain, angle.result, angle.proof, angle.methodology
- verbatim.pain_quote, verbatim.result_quote, verbatim.goal_quote
- icp.role, icp.industry, icp.kpis, icp.apollo_titles, icp.company_size, icp.apollo_employee_ranges, icp.geography, icp.company_revenue
- situation.current_lead_gen, situation.revenue_range, situation.team_size, situation.biggest_challenge

CRITICAL: The [REP] is pitching THEIR service (webinar acquisition / lead-gen / "9-week onboarding" / "predictable pipeline" / "HubSpot integration" / "$1,400+ clients" / "$500M+ revenue"). NEVER let [REP] language describe the prospect's product, customers, pain, or results. If the only support for one of the fields above comes from [REP] turns, return null with _provenance "missing". Better an empty field than a contaminated one — the downstream copywriter can fall back to the website; it cannot recover from a brief that mistakes the rep's pitch for the prospect's business.

Two narrow inference exceptions (everything else stays strict):
1. prospect.contact_title — if the speaker is clearly the owner/operator (signals: "I built", "we built", "my team", "my company", "my $X/month", "I have a sales lead", "I run this") but never states a title verbatim, you MAY default to "Founder & Owner". Record this in _provenance as "inferred".
2. metrics.ltv — if a clear price is explicitly stated ("$5,000/year", "$500 setup + $500/month"), you MAY compute the annual deal value and report it (e.g. "$5,000/year"). Record _provenance as "computed". If no price is stated, return null. Never compute LTV from goal language like "I want $30k/month" — that's a future goal, not a current price.

NEVER infer: close_rate, show_rate, revenue_range (current revenue), case study numbers, proof figures, geography. If those aren't stated explicitly, return null with _provenance "missing".

Return valid JSON only. No markdown, no explanation.`;

  const userPrompt = `Known contact info (treat as ground truth if not contradicted):
Company: ${knownCompany || 'unknown — extract from transcript'}
Name: ${knownName || 'extract from transcript'}
Website: ${knownWebsite || 'extract from transcript'}

${transcriptContent ? `${transcriptContent}\n---` : '(No transcript available)'}
${websiteContent ? `\nWEBSITE CONTENT:\n---\n${websiteContent.slice(0, 2000)}\n---` : ''}

Return this exact JSON (null for anything not found):
{
  "prospect": {
    "company":       "string — the prospect's LEGAL EMPLOYER / business entity. NOT their product, methodology, framework, or offering. CRITICAL DISTINCTION: a company is who they work for (the entity on their LinkedIn 'Experience' section, the entity that owns their website). An offering/product is what they sell ('our system X', 'we built X', 'X helps clients'). Examples — if the prospect says 'I'm Jake, founder of 4FP Agency, and we built Fiddle Link AI for RIAs': company='4FP Agency', NOT 'Fiddle Link AI'. If they say 'I run Acme Consulting and we use the Devoted Client Method': company='Acme Consulting', NOT 'Devoted Client Method'. Resolution rules: (1) Strongest signal is the verified known value (from CRM / website). Trust it unless the transcript provides clear evidence the person works at a different entity. (2) Override the known value only when the transcript explicitly states a different employer ('I'm the CEO of X', 'I founded X', 'I work at X'). Phrases like 'we built X', 'our X', 'X is our system' point to an offering and DO NOT override company. (3) When the transcript is silent on employer name, use the known value. (4) Never invent a name that appears in neither source. (5) If the call mentions BOTH a company AND an offering, put the legal entity here and the product/methodology in 'offering_name'.",
    "contact_name":  "string | null — full name of person on the call",
    "contact_title": "string | null — their job title. Extract verbatim if stated. Otherwise apply the contact_title inference exception from the rules above (default to 'Founder & Owner' when ownership is clear, set _provenance.\"prospect.contact_title\" = \"inferred\").",
    "offering_name": "string | null — the name of the product, service, app, framework, or methodology the prospect is building/selling, IF separate from the company name. NOT the company itself. Examples: 'Fiddle Link AI', 'The Revenue Engine', 'Devoted Client Attraction Method'. Extract verbatim from the call. Null if (a) no specific named offering is mentioned, or (b) the offering and the company share the same name.",
    "offer_description": "string | null — a 1-3 sentence description of WHAT THE PROSPECT'S BUSINESS DOES / SELLS, written so a downstream copywriter can use it verbatim in calendar-invite copy. Plain English, no marketing fluff: who they help, what they deliver, and (if mentioned) the headline outcome. Sources in priority order: (1) the prospect's own description of their service from the call, (2) the website's hero / about-page summary, (3) the company name + offering_name + angle.result rolled into a sentence. Examples — Good: 'Helps independent financial advisors win HNW clients through a 90-day done-with-you marketing program that replaces cold outreach with referral-quality inbound leads.' Bad: 'A revolutionary platform empowering professionals to unlock their full potential.' Always produce something usable — only null if there is literally zero signal in the transcript or website.",
    "business_model": "string — REQUIRED. One of: 'consulting' | 'coaching' | 'agency' | 'managed_service' | 'lead_gen' | 'saas' | 'platform' | 'product' | 'unknown'. Determines whether the downstream webinar should be framed as EDUCATIONAL (host teaches the attendee a system to implement) or DELIVERY-FOCUSED (host produces an outcome the attendee just receives). Definitions: consulting = sells advice/expertise/strategy work, deliverable is recommendations or done-with-you implementation; coaching = sells 1:1 or group coaching/programs, attendee learns and implements; agency = done-WITH-you (attendee still owns the outcome, agency executes alongside); managed_service = done-FOR-you operational service (attendee outsources entirely — e.g. fractional CFO, virtual assistant team, fulfillment); lead_gen = pay-per-lead / pay-per-call / CPL / CPA / CPC vendor that delivers qualified leads as a commodity; saas = self-serve software product the customer uses themselves; platform = multi-sided marketplace or platform connecting parties; product = physical product, app, hardware, or one-time digital product; unknown = genuinely indeterminate from the transcript AND website. CRITICAL: this controls the entire webinar copy shape downstream — a consulting host gets 'we teach you how to build X' framing, a lead_gen host gets 'we deliver X leads to you' framing. Mis-classifying as 'consulting' when host is 'lead_gen' or 'managed_service' produces copy that frames the attendee as having to 'build a system' when in reality the host builds/runs it for them — that's the single most common quality failure of this generator. When in doubt between consulting/agency vs managed_service/lead_gen, ask: does the host's customer have to learn/implement anything, or do they just pay and receive an outcome? If they receive an outcome with no implementation work, it's managed_service or lead_gen, NOT consulting.",
    "website":       "string | null — the prospect's company website, ONLY if explicitly spoken on the call ('our site is turnyellow.com', 'check us out at mfundvc.com', 'we're at quantum-scaling.com'). Strip protocol, www, and trailing slashes — return the bare host like 'turnyellow.com'. NEVER infer from company name. NEVER guess from email domain. Null if no URL is mentioned verbatim."
  },
  "icp": {
    "role":          "string | null — human-readable description of their target buyers (used for display only)",
    "target_audience_type": "string — 'b2b' if the buyer is a person at a business (any role: Property Manager, CEO, Marketing Director, etc), 'b2c' if the buyer is a private consumer (homeowner, resident, individual end-user, member of the public), or 'mixed' if the prospect explicitly serves both. Default 'b2b' if unclear. CRITICAL: this drives whether Apollo is used at all — Apollo is a B2B contact database with no consumer records.",
    "apollo_titles": "array of strings | null — EXACTLY 3-6 standalone job titles for Apollo API search. STRICT RULES: (1) Each entry must be a real B2B job title a person would hold — 2-4 words max. (2) NEVER include consumer/B2C terms (Homeowner, Resident, Tenant, Consumer, Buyer, End-user) — those belong in target_audience_type='b2c'. (3) NEVER include sentence fragments, descriptions, qualifiers, or phrases. If the transcript says 'senior decision-makers at organizations with 50+ employees' — extract titles: ['CEO', 'Director of Strategy', 'Head of Operations']. (4) Self-check each entry: would this appear verbatim on a LinkedIn profile or business card? If not — it is wrong, replace it. VALID: ['CEO', 'Managing Director', 'VP Sales', 'Head of Strategy', 'Chief Operating Officer', 'Property Manager', 'Facilities Manager']. INVALID: ['Homeowner', 'particularly in government', 'large enterprises', 'goals', 'accountability']. If titles not stated, INFER from role/industry context. Null if target_audience_type='b2c' or buyer role is completely indeterminate.",
    "apollo_keyword": "string | null — a SINGLE short free-text phrase (1-3 words) describing the INDUSTRY THE BUYER'S EMPLOYER OPERATES IN. This is fed into Apollo's q_keywords (free-text company search), NOT a tag — so use plain natural language, not Apollo enums. CRITICAL DISTINCTION — extract the buyer's employer industry, NOT the topic/solution the prospect is selling: ✗ Solar company selling to property managers → 'renewables' is WRONG (that's the seller's domain). ✓ → 'property management' or 'real estate'. ✗ Marketing agency selling to SaaS founders → 'marketing' is WRONG. ✓ → 'software'. ✗ Roofing company selling to facilities managers at hotels → 'roofing' is WRONG. ✓ → 'hospitality' or 'commercial real estate'. Ask yourself: 'If I looked up this buyer on LinkedIn, what industry would their EMPLOYER be listed under?' That is the answer. Examples of valid values: 'real estate', 'property management', 'hospitality', 'manufacturing', 'software', 'healthcare', 'financial services', 'construction', 'education', 'logistics', 'retail', 'consulting'. Null if target_audience_type='b2c' or the buyer's industry is genuinely indeterminate (e.g. 'CEOs of any company' with no sector specified).",
    "industry":      "string | null — same as apollo_keyword — kept as a separate field for display compatibility",
    "company_size":  "string | null — human-readable size of their TARGET clients, for display only (e.g. '50-200 employees', 'mid-market', 'enterprise'). Concise — not a full sentence.",
    "apollo_employee_ranges": "array of strings | null — Apollo API employee range codes for their TARGET clients. Choose ONLY from these exact strings: '1,10', '11,50', '51,200', '201,500', '501,1000', '1001,10000', '10001,50000', '50001+'. Match to the described size: '50+ employees, ideally 100+' → ['51,200','201,500']. 'Enterprise/large organizations' → ['501,1000','1001,10000','10001,50000']. CRITICAL RULE: if transcript mentions 'enterprise', 'large organizations', 'government agencies', 'Fortune 500', 'enterprise clients', or any equivalent → you MUST include '1001,10000' in the ranges. Government agencies and large enterprises are typically 1000+ employees. 'Small businesses under 10' → ['1,10']. Select 1-4 contiguous ranges that bracket the target. Null if no size mentioned.",
    "geography":     "string | null — target geography narrative, only if explicitly mentioned",
    "apollo_geography": "array of strings | null — clean country/region names for Apollo API. ONLY extract geography that is EXPLICITLY MENTIONED IN THIS TRANSCRIPT — do NOT echo example country names from these instructions. Valid entries: country names, continent names ('Europe', 'Asia', 'North America'), US/Canadian/Australian states or provinces, major cities. STRICT RULES: (1) NEVER include language names (e.g. a language name is not a location — extract the country instead). (2) NEVER write 'European Union' — expand to the specific member countries the transcript actually names. If the transcript says 'EU' with no specifics, use ['Europe']. (3) NEVER include narrative phrases. (4) Extract ONLY location nouns the transcript states. (5) If the transcript mentions a region grouping (e.g. 'Baltic states', 'DACH', 'Nordics', 'MENA'), expand it to the standard member countries — but only when the transcript explicitly used that grouping. (6) DO NOT default to any specific country list when the transcript is silent about geography — return null. Null if no geography is mentioned at all.",
    "person_seniorities": "ALWAYS return null. The Apollo search uses only titles + size + location + industry keyword. Adding a seniorities filter on top of specific titles like 'Chief Marketing Officer' double-narrows the TAM because Apollo's seniority tagging is heuristic and misses many legitimate CEOs. Do not extract seniorities from the transcript.",
    "company_revenue": "string | null — revenue range of their TARGET clients if mentioned or clearly implied (e.g. '$1M-$5M', '$500K+', '$2M ARR'). Verbatim if stated, short inference if strongly implied. Null if not determinable.",
    "kpis":          "array of 3-5 strings — the specific business performance metrics the prospect's service directly helps their ICP improve. Extract verbatim if mentioned. If not explicitly stated, INFER from the service description, promised outcomes, and problems solved — look at what their clients gain. Return short, specific metric names like 'Revenue per client', 'Customer acquisition rate', 'Client retention rate', 'Brand visibility', 'Lead conversion rate', 'Average deal size'. Never null — always infer at least 3."
  },
  "metrics": {
    "ltv":        "string | null — client lifetime value. If a clear annual or one-time price is stated, compute the annual value (e.g. '$5,000/year') and set _provenance.\"metrics.ltv\" = \"computed\". If stated verbatim ('LTV is $20k'), use that verbatim with _provenance \"transcript\". NEVER compute from goal language ('I want $30k/month'). null + _provenance \"missing\" if no price/LTV.",
    "close_rate": "string | null — current close rate, verbatim from transcript. NEVER infer. null + _provenance \"missing\" if not explicitly stated.",
    "show_rate":  "string | null — current show/attendance rate, verbatim from transcript. NEVER infer. null + _provenance \"missing\" if not explicitly stated."
  },
  "angle": {
    "pain":        "string | null — the DEEP, specific, emotional frustration their clients experience. Go beyond the surface problem: what does it actually cost them (money, time, stress, missed opportunity)? What have they tried that didn't work? What does failure look or feel like for their client day-to-day? Write in customer language — raw frustration, not a polished problem statement. Pull their exact words from the transcript wherever possible. 4-6 sentences.",
    "result":      "string | null — the concrete before/after transformation they deliver. What specifically changes for the client? What does their business or life look like 6-12 months after working with this person? Be specific about outcomes — revenue, time saved, stress removed, capability gained. Include verbatim numbers if mentioned. 3-5 sentences.",
    "methodology": "string | null — their named framework or system if they mentioned one (exact name)",
    "proof":       "string | null — their single best client outcome with specific numbers verbatim"
  },
  "verbatim": {
    "pain_quote":   "string | null — exact verbatim quote (≤40 words) of the prospect describing their clients' biggest pain. Must be their actual spoken words. null if no clear quote.",
    "result_quote": "string | null — exact verbatim quote (≤30 words) of the prospect describing what they deliver. null if no clear quote.",
    "goal_quote":   "string | null — exact verbatim quote (≤30 words) of what they want to achieve. null if no clear quote."
  },
  "situation": {
    "current_lead_gen": "string | null — how they currently get clients, verbatim or close paraphrase (e.g. '100% referrals', 'cold email + LinkedIn + events')",
    "revenue_range":    "string | null — their current revenue if mentioned (e.g. '$2M ARR', '$500K-$1M/year')",
    "team_size":        "string | null — their team/company size if mentioned",
    "biggest_challenge":"string | null — the single most important challenge they named for their own business growth (not their clients' challenges). 1-2 sentences."
  },
  "context": {
    "goals":       "string | null — what they want to achieve in next 6-12 months",
    "why_webinar": "string | null — why they are exploring webinars or this system specifically"
  },
  "titles": {
    "a": "string | null — compelling webinar title based on their pain + result, max 70 chars",
    "b": "string | null — second variant with different angle or audience framing, max 70 chars"
  },
  "_provenance": {
    "prospect.company":        "one of: transcript | inferred | missing — how you got this value",
    "prospect.contact_name":   "one of: transcript | inferred | missing",
    "prospect.contact_title":  "one of: transcript | inferred | missing — use 'inferred' when ownership is clear but title not stated verbatim",
    "prospect.offering_name":  "one of: transcript | missing",
    "prospect.offer_description": "one of: transcript | website | inferred | missing — 'website' if drawn from the scraped site copy, 'inferred' if synthesized from company + offering + angle.result, 'transcript' if quoted",
    "prospect.business_model":    "one of: transcript | website | inferred | unknown — 'transcript' if the prospect explicitly described their delivery model, 'website' if classified from the scraped site copy (look for 'pay-per-lead', 'done-for-you', 'self-serve', 'we generate / deliver / handle', etc.), 'inferred' if synthesized from offering_name + offer_description, 'unknown' if genuinely indeterminate",
    "prospect.website":           "one of: transcript | missing — 'transcript' if the prospect spoke their URL on the call, 'missing' otherwise",
    "icp.role":                "one of: transcript | missing",
    "icp.industry":            "one of: transcript | missing",
    "icp.company_size":        "one of: transcript | missing",
    "icp.geography":           "one of: transcript | missing — NEVER fabricate or echo example countries from the instructions; missing if the transcript is silent",
    "icp.company_revenue":     "one of: transcript | missing",
    "metrics.ltv":             "one of: transcript | computed | missing — 'computed' when derived from a stated price",
    "metrics.close_rate":      "one of: transcript | missing — NEVER inferred",
    "metrics.show_rate":       "one of: transcript | missing — NEVER inferred",
    "angle.pain":              "one of: transcript | missing",
    "angle.result":            "one of: transcript | missing",
    "angle.methodology":       "one of: transcript | missing",
    "angle.proof":             "one of: transcript | missing — NEVER inferred",
    "situation.revenue_range": "one of: transcript | missing — NEVER inferred from goals",
    "situation.team_size":     "one of: transcript | missing",
    "situation.current_lead_gen": "one of: transcript | missing",
    "context.goals":           "one of: transcript | missing"
  }
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const raw = message.content[0].text;
  return extractJsonObject(raw); // null → modal opens blank for manual entry
}

function emptyBrief(contactInfo) {
  const company = contactInfo.company || null;
  const name    = contactInfo.name    || null;
  const title   = contactInfo.title   || null;
  return {
    prospect:  { company, contact_name: name, contact_title: title, offering_name: null, offer_description: null, website: null },
    icp:       { role: null, target_audience_type: 'b2b', apollo_titles: null, apollo_keyword: null, industry: null, company_size: null, apollo_employee_ranges: null, geography: null, apollo_geography: null, person_seniorities: null, company_revenue: null, kpis: null },
    metrics:   { ltv: null, close_rate: null, show_rate: null },
    angle:     { pain: null, result: null, methodology: null, proof: null },
    verbatim:  { pain_quote: null, result_quote: null, goal_quote: null },
    situation: { current_lead_gen: null, revenue_range: null, team_size: null, biggest_challenge: null },
    context:   { goals: null, why_webinar: null },
    titles:    { a: null, b: null },
    _provenance: {
      // External fields populated by GHL/Apollo/website_title at prefetch time —
      // marked as missing if not filled; the prefetch wrapper overlays the right
      // source. Transcript-only fields stay missing because there was no transcript.
      'prospect.company':        company ? 'external' : 'missing',
      'prospect.contact_name':   name    ? 'external' : 'missing',
      'prospect.contact_title':  title   ? 'external' : 'missing',
      'icp.geography':           'missing',
      'metrics.ltv':             'missing',
      'metrics.close_rate':      'missing',
      'metrics.show_rate':       'missing',
      'angle.pain':              'missing',
      'angle.result':            'missing',
      'angle.proof':             'missing',
      'situation.revenue_range': 'missing',
    },
  };
}

// ── Apollo helpers ────────────────────────────────────────────────────────────
function mapCompanySize(sizeStr) {
  if (!sizeStr) return ['11,50', '51,200'];
  const s = sizeStr.toLowerCase();
  if (/solo|1.person|solopreneur/.test(s)) return ['1,1'];
  if (/\bsmall\b/.test(s) && !/team/.test(s)) return ['1,10'];
  if (/1.10|under 10|fewer than 10/.test(s)) return ['1,10'];
  if (/10.50|startup|small.*team/.test(s)) return ['1,10', '11,50'];
  if (/1000\+|1,000\+|very large/.test(s)) return ['1001,10000'];
  if (/500\+|enterprise|large/.test(s)) return ['501,1000', '1001,10000'];
  if (/200.500|mid.market/.test(s)) return ['201,500'];
  if (/100\+|ideally 100/.test(s)) return ['101,200', '201,500'];
  if (/50\+/.test(s) && !/200|500|1000/.test(s)) return ['51,200'];
  if (/50.200|mid.size|growing/.test(s)) return ['51,200'];
  return ['11,50', '51,200'];
}
function fmtEmp(n) {
  if (!n) return '';
  if (n <= 10) return `${n} emp`;
  if (n <= 200) return `${Math.round(n/10)*10} emp`;
  if (n <= 1000) return `~${Math.round(n/100)*100} emp`;
  return `${Math.round(n/1000)}K+ emp`;
}

// Collapses Apollo's apollo_employee_ranges (e.g. ['1,10','11,50','51,200']) into a
// single display string for the Size column when exact employee counts aren't
// returned by search. ['1,10','11,50','51,200'] → '1–200 emp'.
function formatEmployeeRangeBand(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return '';
  const bounds = ranges
    .map(r => String(r).split(',').map(n => parseInt(n, 10)))
    .filter(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi));
  if (!bounds.length) return '';
  const lo = Math.min(...bounds.map(b => b[0]));
  const hi = Math.max(...bounds.map(b => b[1]));
  return lo === hi ? `${lo} emp` : `${lo}–${hi} emp`;
}

// Bulk people-match for an array of deduped leads. Costs 1 Apollo enrichment
// credit per lead with an apollo_id (so ~25 credits per fresh lead_list / rerun).
// Why every lead, every time:
//   - Search responses strip last_name (obfuscated as "Mo***e"), email, and
//     employee count on this Apollo plan. Match unlocks all three.
//   - Pre-matching at lead_list time means the rep sees real names + emails
//     immediately in the table; no per-lead Reveal click required for the
//     baseline view. (Reveal button is still wired for old jobs that don't
//     have apollo_id, and as a manual refresh if anything ever needs it.)
// The website column intentionally stays on the free proxy-scrape value; this
// helper only overrides name / email / company_size when match returns them.
async function peopleMatchAllLeads(leads, cache = null) {
  const APOLLO_KEY = process.env.APOLLO_API_KEY;
  if (!APOLLO_KEY || !Array.isArray(leads) || !leads.length) return leads;

  // Phase 0: hydrate from prior-job cache before any Apollo call. Saves 1
  // credit per lead that the same prospect has already enriched on a previous
  // run. The cache is keyed by apollo_id (stable across reruns).
  let cacheHits = 0;
  if (cache && cache.size) {
    for (const lead of leads) {
      if (!lead || !lead.apollo_id || lead.revealed) continue;
      const hit = cache.get(lead.apollo_id);
      if (!hit) continue;
      if (hit.name)         lead.name         = hit.name;
      if (hit.email)        lead.email        = hit.email;
      if (hit.company_size) lead.company_size = hit.company_size;
      if (hit.website)      lead.website      = hit.website;
      if (hit.linkedin_url) lead.linkedin_url = hit.linkedin_url;
      if (hit.photo_url)    lead.photo_url    = hit.photo_url;
      if (hit.headline)     lead.headline     = hit.headline;
      lead.revealed = true;
      cacheHits++;
    }
  }

  const targets = leads.filter(l => l && l.apollo_id && !l.revealed);
  if (!targets.length) {
    if (cacheHits) console.log(`[lead_list] People-match: 0/${cacheHits + targets.length} new calls (${cacheHits} reused from prior jobs — 0 credits)`);
    return leads;
  }

  const CONCURRENCY = 5;
  let matched = 0;
  let websiteFromEmail = 0;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (lead) => {
      try {
        const r = await fetch('https://api.apollo.io/api/v1/people/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_KEY },
          body: JSON.stringify({ id: lead.apollo_id }), // NO reveal_personal_emails, NO reveal_phone_number
          signal: AbortSignal.timeout(10000)
        });
        if (!r.ok) return;
        const d = await r.json();
        const p = d.person || {};
        if (p.first_name && p.last_name) {
          lead.name = `${p.first_name} ${p.last_name}`.trim();
        } else if (p.name) {
          lead.name = p.name;
        }
        if (p.email) lead.email = p.email;
        const emp = p.organization?.estimated_num_employees;
        if (Number.isFinite(emp) && emp > 0) lead.company_size = fmtEmp(emp);
        // Validate / fill Website from the work-email domain when it's
        // non-free-mail and roughly matches the company name. The email domain
        // is the most authoritative source for "where does this person work"
        // — overrides any prior value from the DDG proxy scrape, which can land
        // on adjacent pages (regulator websites, news, directory listings).
        if (lead.email) {
          const emailDomain = (lead.email.split('@')[1] || '').toLowerCase().trim();
          if (emailDomain && !isFreeMailDomain(emailDomain) && emailDomainMatchesCompany(emailDomain, lead.company)) {
            const newSite = 'https://' + emailDomain;
            if (lead.website !== newSite) {
              lead.website = newSite;
              websiteFromEmail++;
            }
          }
        }
        lead.revealed = true;
        matched++;
      } catch (e) {
        // Match failure is non-fatal — lead still renders with obfuscated name,
        // and the rep can manually click Reveal to retry the single lead.
      }
    }));
  }
  console.log(`[lead_list] People-match: ${matched}/${targets.length} leads matched (${matched} enrichment credits) | reused from prior jobs: ${cacheHits} | website set from email domain: ${websiteFromEmail}`);
  return leads;
}

// Shared finalizer for the lead list. Used by handleLeadList (worker path) AND
// the POST /api/jobs/:id/rerun-apollo handler — both used to have their own
// dedup logic. Without this, rerun-apollo persisted the raw 50-lead Apollo
// response (no dedup, no Size column fallback), and the lead-table UI would
// show duplicates and empty Size cells for every job that was re-run.
//
// Steps:
//   1. Dedup by company name (case-insensitive). First occurrence wins;
//      Apollo's default ranking puts higher-relevance contacts first.
//   2. Cap at 25 leads (spec §11b — "never two contacts from the same company").
//   3. Apply the ICP's employee-range band as a Size fallback whenever the lead
//      itself has no company_size (which is every lead on this Apollo plan tier,
//      since people search responses strip estimated_num_employees).
//   4. People-match all 25 to unlock full name + work email + real employee count
//      (25 enrichment credits per finalize call). Step (3) still applies as a
//      fallback whenever match doesn't return an employee count.
async function finalizeLeadList(rawLeads, icp, enrichmentCache = null) {
  const seen = new Set();
  const deduped = [];
  for (const l of (rawLeads || [])) {
    const key = (l.company || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(l);
    if (deduped.length >= 25) break;
  }
  const sizeFallback = formatEmployeeRangeBand(icp?.apollo_employee_ranges);
  if (sizeFallback) {
    deduped.forEach(l => { if (!l.company_size) l.company_size = sizeFallback; });
  }
  await peopleMatchAllLeads(deduped, enrichmentCache);
  // Stale-code alarm bell. peopleMatchAllLeads filters on `l.apollo_id`; if
  // no lead has one, the match step silently does nothing and the rep ends up
  // staring at obfuscated names. The only way 25 freshly-searched leads can
  // all lack apollo_id is when the running container is using an older
  // build of normalizePerson that pre-dates the apollo_id field — i.e. a
  // module-cache miss after a Render deploy. Surface it loudly so the next
  // time it happens we catch it in the logs instead of from a UI complaint.
  const withId = deduped.filter(l => l && l.apollo_id).length;
  if (deduped.length > 0 && withId === 0) {
    console.warn(`[lead_list] ⚠ 0/${deduped.length} leads have apollo_id — `
      + `normalizePerson is running stale code (no people-match possible). `
      + `Force a clearCache redeploy on Render and rerun this job.`);
  } else if (deduped.length > 0 && withId < deduped.length) {
    console.warn(`[lead_list] ${withId}/${deduped.length} leads have apollo_id — partial match coverage`);
  }
  return { leads: deduped, sizeFallback };
}
const PARKING_SIGNALS = ['domain for sale','this domain is for sale','buy this domain','coming soon','under construction','parked by','domain parking'];
// ── Jina AI Reader — JS-rendering-aware website scraper ─────────────────────
// Replaces raw fetch() + HTML parser. Jina runs a headless browser on their end,
// so React/Next.js/Vue sites return actual content instead of empty shells.
// No API key required. Format: https://r.jina.ai/{full-url}
async function websiteQualityCheck(url, timeoutMs = 7000) {
  if (!url) return null;
  const jinaFetch = async (targetUrl) => {
    try {
      const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) return '';
      return (await res.text()).trim();
    } catch(e) { return ''; }
  };

  const base = url.replace(/\/$/, '');

  // Step 1: fetch homepage
  let text = await jinaFetch(base);

  // Step 2: if homepage is thin (<250 chars), try /about and /about-us in parallel
  // About pages have higher signal density — they describe who the company serves,
  // not just marketing taglines.
  if (text.length < 250) {
    const [a, b] = await Promise.all([jinaFetch(`${base}/about`), jinaFetch(`${base}/about-us`)]);
    const best = [a, b].sort((x, y) => y.length - x.length)[0];
    if (best.length > text.length) text = best;
  }

  if (text.length < 100) return null; // parked domain or completely empty
  if (PARKING_SIGNALS.some(s => text.toLowerCase().includes(s))) return null;

  // Jina already strips nav/footer/boilerplate — just trim to 500 chars
  return { excerpt: text.slice(0, 500) };
}
function normalizePerson(p, source) {
  // Normalize contact shape from people search into one format.
  //   - last_name_obfuscated instead of last_name on this plan
  //   - organization.name instead of organization_name
  //   - personal linkedin_url is paywalled in search; hydrate via people/match on reveal
  const org = p.organization || p.account || {};
  const name = p.name
    || (p.first_name && (p.last_name || p.last_name_obfuscated)
        ? `${p.first_name} ${p.last_name || p.last_name_obfuscated}`.trim()
        : (p.first_name || null));
  const company = p.organization_name || org.name || org.short_description || null;
  const website = p.website_url || org.website_url || org.primary_domain || org.domain || org.primary_domain_url || null;
  const employeeCount = p.organization_num_employees || org.estimated_num_employees || org.employees || null;
  return {
    apollo_id:           p.id || null,                                  // needed for on-demand reveal
    name,
    title:               p.title,
    company,
    company_size:        fmtEmp(employeeCount),
    website,
    linkedin_url:        p.linkedin_url || null,                        // display URL — company LI fills this in via hydration; reveal swaps in personal LI
    company_linkedin_url: null,                                         // populated by enrichLeadsWithCompanyData
    photo_url:           null,                                          // populated on reveal
    email:               null,                                          // populated on reveal
    headline:            null,                                          // populated on reveal
    revealed:            false,                                         // true after rep clicks Reveal (1 enrichment credit spent)
    _source: source
  };
}

// ── Company hydration — DuckDuckGo scrape via Jina Reader (zero Apollo credits) ──
// People search returns only org.name on this plan; Apollo's mixed_companies/search
// would fill website + company LinkedIn but it costs 1 credit per call (verified by
// isolation test: 10 search calls → +10 enrichment credits). At 25 unique companies
// per job that's 25 silent credits per fresh search and per rerun.
//
// Replaced with a free search-engine scrape. We hit DuckDuckGo's HTML SERP through
// Jina Reader (no API key, already used elsewhere in this file). DuckDuckGo wraps
// each organic result URL inside a `duckduckgo.com/l/?uddg=<encoded-real-url>` link
// — we parse those, decode them, then pick:
//   - first non-social/non-directory hostname  → website
//   - first linkedin.com/company/...           → company_linkedin_url
// Accuracy in spot-checks: ~85% on Website, ~70% on Company LinkedIn. Reveal still
// overrides both with Apollo's authoritative data when the rep wants 100% accuracy.
//
// Cache is process-local. Render restarts on deploy (~daily), which resets it —
// fine because the same company name returns the same domain regardless.
const _companyLookupCache = new Map();

const _DDG_HOST_NOISE = /^(?:wikipedia|wikidata|bbb|manta|crunchbase|bloomberg|pitchbook|zoominfo|rocketreach|owler|capterra|g2|forbes|nytimes|wsj|reuters|cnbc|reddit|youtube|facebook|twitter|instagram|tiktok|threads\.net|x\.com|medium\.com|substack\.com|quora|signalhire|apollo\.io|duckduckgo|ddg\.gg|yahoo\.com|bing\.com|google\.com|googleusercontent|amazon|amzn|ebay|yelp|glassdoor|indeed)\./i;

function _extractFromDDG(text) {
  if (!text) return { website: null, company_linkedin_url: null };
  // DDG wraps every result: /l/?uddg=<urlencoded-real-url>&rut=...
  const matches = [...text.matchAll(/duckduckgo\.com\/l\/\?uddg=([^&\s\)\"']+)/g)];
  let website = null, companyLi = null;
  for (const m of matches) {
    let real;
    try { real = decodeURIComponent(m[1]); } catch { continue; }
    let u;
    try { u = new URL(real); } catch { continue; }
    const host = u.hostname.replace(/^www\./, '');
    if (!host) continue;
    if (!companyLi && /linkedin\.com$/.test(host) && /\/company\//.test(u.pathname)) {
      companyLi = 'https://www.linkedin.com' + u.pathname.replace(/\/$/, '');
    }
    if (!website
        && !_DDG_HOST_NOISE.test(host)
        && !/linkedin\.com$/.test(host)
        && !/\.(gov|edu|mil)$/.test(host)
        && host.split('.').length >= 2) {
      website = 'https://' + host;
    }
    if (website && companyLi) break;
  }
  return { website, company_linkedin_url: companyLi };
}

async function _searchEngineLookupCompany(name) {
  const key = (name || '').toLowerCase().trim();
  if (!key) return { website: null, company_linkedin_url: null };
  if (_companyLookupCache.has(key)) return _companyLookupCache.get(key);
  let result = { website: null, company_linkedin_url: null };
  const proxyKey = process.env.CORSPROXY_API_KEY;
  if (!proxyKey) {
    // Single-IP scraping trips DDG's captcha within a handful of calls
    // (verified locally — got HTTP 202 + 14 KB block pages from both Jina and
    // direct DDG after the first batch). Without the proxy we skip silently and
    // let the Website cell render as "—". Reveal still populates from Apollo.
    _companyLookupCache.set(key, result);
    return result;
  }
  try {
    const target = 'https://duckduckgo.com/html/?q=' + encodeURIComponent(name);
    const url = 'https://corsproxy.io/?key=' + encodeURIComponent(proxyKey)
              + '&url=' + encodeURIComponent(target);
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const text = await r.text();
      // Captcha pages from DDG are ~14 KB but contain no uddg redirects, so
      // the parser already returns nulls for them. The length gate is a cheap
      // pre-check before doing the regex pass.
      if (text.length > 5000) result = _extractFromDDG(text);
    }
  } catch (e) {
    // Network failure / timeout — leave result null; lead still renders
  }
  _companyLookupCache.set(key, result);
  return result;
}

async function enrichLeadsWithCompanyData(leads, progressCb) {
  if (!leads.length) return leads;

  const uniqueCompanies = [...new Set(leads.map(l => l.company).filter(Boolean))];
  if (!uniqueCompanies.length) return leads;

  const orgByName = new Map();
  // corsproxy.io rotates the outbound IP so DDG's per-IP rate limit doesn't
  // bite us. Burst test of 25 names at concurrency 5 came back in 5.5s with
  // 25/25 hits. Without the proxy key we skip the call entirely (see
  // _searchEngineLookupCompany), so this concurrency only applies when we have
  // a working proxy.
  const CONCURRENCY = 5;
  let done = 0;

  for (let i = 0; i < uniqueCompanies.length; i += CONCURRENCY) {
    const batch = uniqueCompanies.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (name) => {
      const r = await _searchEngineLookupCompany(name);
      if (r.website || r.company_linkedin_url) orgByName.set(name, r);
    }));
    done = Math.min(uniqueCompanies.length, done + batch.length);
    // Hydration phase = 65 → 90% of overall progress; 25% range distributed across companies.
    // Awaited so a stale progress write can't land after the persist step at the end
    // of rerun-apollo and clobber the final status='completed' state.
    if (progressCb) {
      const pct = 65 + Math.round((done / uniqueCompanies.length) * 25);
      await progressCb({ progress: pct, message: `Looking up company websites (${done}/${uniqueCompanies.length})…` });
    }
  }

  let hits = 0;
  leads.forEach(l => {
    const o = orgByName.get(l.company);
    if (!o) return;
    if (!l.website && o.website) l.website = o.website;
    // Store the canonical company LI; mirror to linkedin_url only as the pre-reveal
    // display fallback. Reveal will overwrite linkedin_url with the authoritative
    // company URL from Apollo (or eventually the personal URL if we extend scope).
    if (o.company_linkedin_url) {
      l.company_linkedin_url = o.company_linkedin_url;
      if (!l.linkedin_url) l.linkedin_url = o.company_linkedin_url;
    }
    if (o.website || o.company_linkedin_url) hits++;
  });
  console.log(`[hydration] DDG-scrape: ${hits}/${leads.length} leads enriched (${orgByName.size}/${uniqueCompanies.length} unique companies looked up, cache size ${_companyLookupCache.size})`);
  return leads;
}

// ── EU countries list for Apollo geo expansion ─────────────────────────────────
const EU_COUNTRIES = [
  'Austria','Belgium','Bulgaria','Croatia','Cyprus','Czech Republic','Denmark',
  'Estonia','Finland','France','Germany','Greece','Hungary','Ireland','Italy',
  'Latvia','Lithuania','Luxembourg','Malta','Netherlands','Poland','Portugal',
  'Romania','Slovakia','Slovenia','Spain','Sweden',
  // Common non-EU European markets often meant when prospects say "Europe"
  'United Kingdom','Norway','Switzerland','Iceland'
];

// ── v3 Apollo Pipeline Functions ──────────────────────────────────────────────

const VALID_SENIORITIES = new Set([
  'owner', 'founder', 'c_suite', 'partner', 'vp',
  'head', 'director', 'manager', 'senior', 'entry', 'intern'
]);

const VALID_EMAIL_STATUSES = new Set([
  'verified', 'unverified', 'likely to engage', 'unavailable'
]);

const EMPLOYEE_RANGE_REGEX = /^\d+,\d+$/;

function sanitizeApolloPayload(payload) {
  const sanitized = { ...payload };
  const warnings = [];

  // Strip empty-array filter keys. Apollo accepts missing keys as "no filter",
  // but empty arrays can leak through translator output or stale ICP edits.
  // The result: a missing apollo_employee_ranges / apollo_geography no longer
  // searches against [] (which silently zeros out the pool on some endpoints)
  // — it just removes the filter and lets the broader pool through.
  const FILTER_ARRAY_KEYS = [
    'person_titles', 'person_seniorities', 'person_locations',
    'organization_locations', 'organization_num_employees_ranges',
    'q_organization_keyword_tags', 'person_department_or_subdepartments',
    'currently_using_any_of_technology_uids'
  ];
  for (const key of FILTER_ARRAY_KEYS) {
    if (Array.isArray(sanitized[key]) && sanitized[key].length === 0) {
      delete sanitized[key];
    }
  }
  if (typeof sanitized.q_keywords === 'string' && !sanitized.q_keywords.trim()) {
    delete sanitized.q_keywords;
  }

  // Validate seniorities
  if (sanitized.person_seniorities) {
    const before = sanitized.person_seniorities.length;
    sanitized.person_seniorities = sanitized.person_seniorities.filter(s =>
      VALID_SENIORITIES.has(s)
    );
    if (sanitized.person_seniorities.length < before)
      warnings.push(`Removed ${before - sanitized.person_seniorities.length} invalid seniorities`);
  }

  // contact_email_status — the new api_search endpoint ignores this filter and returns 0.
  // Remove it to allow the search to return results (has_email is returned per contact).
  if (sanitized.contact_email_status) {
    delete sanitized.contact_email_status;
  }

  // Validate employee ranges format
  if (sanitized.organization_num_employees_ranges) {
    sanitized.organization_num_employees_ranges =
      sanitized.organization_num_employees_ranges.filter(r => EMPLOYEE_RANGE_REGEX.test(r) || r === '10001+');
  }

  // Ensure q_keywords is string not array
  if (Array.isArray(sanitized.q_keywords)) {
    sanitized.q_keywords = sanitized.q_keywords.join(' ');
  }
  // Normalize q_keywords (free text) → q_organization_keyword_tags as a SINGLE tag.
  // Apollo's mixed_people/api_search ignores q_keywords (returns 0 results) and
  // applies AND logic across multiple keyword tags. Putting the entire phrase as
  // one tag keeps it OR-style and preserves industry filtering. We do NOT split
  // on whitespace — that's the historical bug that killed EU coverage.
  if (typeof sanitized.q_keywords === 'string' && sanitized.q_keywords.trim()) {
    const phrase = sanitized.q_keywords.trim();
    if (!Array.isArray(sanitized.q_organization_keyword_tags) || sanitized.q_organization_keyword_tags.length === 0) {
      sanitized.q_organization_keyword_tags = [phrase];
    }
  }
  // Cap q_organization_keyword_tags to a single tag — multiple tags AND-collapse
  // to zero results. The industry signal is now a single phrase by design.
  if (Array.isArray(sanitized.q_organization_keyword_tags) && sanitized.q_organization_keyword_tags.length > 1) {
    warnings.push(`Capped q_organization_keyword_tags from ${sanitized.q_organization_keyword_tags.length} → 1 (AND-trap avoidance)`);
    sanitized.q_organization_keyword_tags = [sanitized.q_organization_keyword_tags[0]];
  }

  // Validate revenue (integers or null)
  if (sanitized.revenue_range) {
    if (sanitized.revenue_range.min !== null && !Number.isInteger(sanitized.revenue_range.min))
      sanitized.revenue_range.min = null;
    if (sanitized.revenue_range.max !== null && !Number.isInteger(sanitized.revenue_range.max))
      sanitized.revenue_range.max = null;
    if (!sanitized.revenue_range.min && !sanitized.revenue_range.max)
      delete sanitized.revenue_range;
  }

  // Normalize technology uids
  if (sanitized.currently_using_any_of_technology_uids) {
    sanitized.currently_using_any_of_technology_uids =
      sanitized.currently_using_any_of_technology_uids.map(t =>
        t.toLowerCase().replace(/[\\s.]/g, '_')
      );
  }

  // Remove empty arrays (can cause Apollo to return 0)
  Object.keys(sanitized).forEach(key => {
    if (Array.isArray(sanitized[key]) && sanitized[key].length === 0)
      delete sanitized[key];
  });

  return { payload: sanitized, warnings };
}

async function preflightCompanyCheck(payload) {
  const APOLLO_KEY = process.env.APOLLO_API_KEY;
  if (!APOLLO_KEY) return { companiesFound: 0 };

  const companyFilters = {};
  // q_keywords is FREE TEXT for company search. Do NOT split into q_organization_keyword_tags —
  // tag-mode applies AND logic and collapses results (especially for EU/non-US markets).
  // Pass the entire phrase as a single free-text query.
  if (payload.q_keywords) companyFilters.q_keywords = String(payload.q_keywords).trim();
  if (payload.organization_num_employees_ranges) companyFilters.organization_num_employees_ranges = payload.organization_num_employees_ranges;
  if (payload.organization_locations) companyFilters.organization_locations = payload.organization_locations;
  if (payload.revenue_range) companyFilters.revenue_range = payload.revenue_range;

  if (Object.keys(companyFilters).length === 0) return { companiesFound: -1 }; // Skip if no org filters

  try {
    const res = await fetch('https://api.apollo.io/v1/organizations/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': APOLLO_KEY
      },
      body: JSON.stringify({ ...companyFilters, per_page: 1 }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { companiesFound: 0 };
    const data = await res.json();
    return { companiesFound: data.pagination?.total_entries || 0 };
  } catch (e) {
    console.warn('[preflightCompanyCheck] Error:', e.message);
    return { companiesFound: -1 };
  }
}

// Returns { action, before, after } so the diagnostics UI can show concrete diffs
// instead of just verbs (e.g. "size 11–200 → 1–500" rather than "size expanded").
// before/after are deep-copied so later mutations to currentPayload don't bleed in.
function relaxFilter(payload, filterName) {
  const cloneVal = v => Array.isArray(v) ? [...v] : v;
  const before = cloneVal(payload[filterName]);

  switch (filterName) {
    case 'revenue_range':
    case 'currently_using_any_of_technology_uids':
      delete payload[filterName];
      return { action: 'removed', before, after: null };

    case 'organization_num_employees_ranges': {
      const ALL = ['1,10','11,20','21,50','51,100','101,200','201,500',
                   '501,1000','1001,2000','2001,5000','5001,10000', '10001+'];
      const indices = payload[filterName].map(r => ALL.indexOf(r)).filter(i => i >= 0);
      if (indices.length === 0) { delete payload[filterName]; return { action: 'removed', before, after: null }; }
      const lo = Math.max(0, Math.min(...indices) - 1);
      const hi = Math.min(ALL.length - 1, Math.max(...indices) + 1);
      payload[filterName] = ALL.slice(lo, hi + 1);
      return { action: 'expanded', before, after: cloneVal(payload[filterName]) };
    }

    case 'q_keywords': {
      const words = payload.q_keywords.split(' ');
      if (words.length > 1) {
        payload.q_keywords = words.slice(0, Math.ceil(words.length / 2)).join(' ');
        return { action: 'simplified', before, after: payload.q_keywords };
      }
      delete payload.q_keywords;
      return { action: 'removed', before, after: null };
    }

    case 'q_organization_keyword_tags':
      // Single industry tag — broaden by removing it entirely (the keyword phrase
      // is the most expendable filter; titles + seniority + size + geo carry the rest).
      delete payload.q_organization_keyword_tags;
      return { action: 'removed', before, after: null };

    case 'person_department_or_subdepartments':
      delete payload[filterName];
      return { action: 'removed', before, after: null };

    case 'organization_locations':
    case 'person_locations':
      delete payload[filterName];
      return { action: 'removed', before, after: null };

    case 'person_seniorities': {
      const HIER = ['intern','entry','senior','manager','director','head','vp','partner','c_suite','founder','owner'];
      const idxs = payload[filterName].map(s => HIER.indexOf(s)).filter(i => i >= 0);
      if (idxs.length === 0) { delete payload[filterName]; return { action: 'removed', before, after: null }; }
      const lo = Math.max(0, Math.min(...idxs) - 1);
      const hi = Math.min(HIER.length - 1, Math.max(...idxs) + 1);
      const expanded = new Set(payload[filterName]);
      expanded.add(HIER[lo]);
      expanded.add(HIER[hi]);
      payload[filterName] = [...expanded];
      return { action: 'expanded', before, after: cloneVal(payload[filterName]) };
    }

    case 'person_titles':
      payload.include_similar_titles = true;
      // Apollo expands these server-side — we don't see the resulting variants
      // here. Show "include_similar_titles" as the after-state marker.
      return { action: 'expanded_similar', before, after: before };

    default:
      delete payload[filterName];
      return { action: 'removed', before, after: null };
  }
}

async function guaranteedLeadSearch(sanitizedPayload, confidenceMap, relaxationOrder, progressCb) {
  const MIN_LEADS = 25;
  const MAX_ATTEMPTS = 6;
  const APOLLO_KEY = process.env.APOLLO_API_KEY;

  if (!APOLLO_KEY) return { leads: [], totalAvailable: 0, finalPayload: sanitizedPayload, relaxationLog: [], wasRelaxed: false };

  let currentPayload = { ...sanitizedPayload };
  let attempt = 0;
  let log = [];

  // ── Protected filters: never auto-stripped during relaxation ──────────────
  // Geography and industry-keyword are core ICP signals. Relaxing them produces
  // generic global leads instead of prospect-specific ones, which violates the
  // product principle "specific leads only, no fillers." If Apollo can't return
  // ≥25 leads without dropping these, we return what's available + the
  // "Market too small" UI label.
  const protectedFilters = new Set();
  if (Array.isArray(sanitizedPayload.organization_locations) && sanitizedPayload.organization_locations.length > 0) {
    protectedFilters.add('organization_locations');
  }
  if (Array.isArray(sanitizedPayload.q_organization_keyword_tags) && sanitizedPayload.q_organization_keyword_tags.length > 0) {
    protectedFilters.add('q_organization_keyword_tags');
  }
  if (protectedFilters.size > 0) {
    log.push({ step: 'protected', filters: [...protectedFilters] });
    console.log('[Apollo] Protected filters (will not be relaxed):', [...protectedFilters]);
  }

  const apolloPeopleSearch = async (payload) => {
    try {
      const body = {
        per_page: Math.max(payload.per_page || 50, MIN_LEADS),
        page: 1,
        ...payload
      };
      // sort_by_field: 'person_name' was rejected by Apollo's api_search backend
      // ("Fielddata is disabled on [person_name] in [people_v5]" — Elasticsearch
      // can't sort on a text field). Strip both sort params explicitly in case the
      // translator-built payload re-introduces them.
      delete body.sort_by_field;
      delete body.sort_ascending;
      // q_keywords is not supported by the api_search endpoint — it causes 0 results.
      // preflightCompanyCheck still uses it via q_organization_keyword_tags.
      delete body.q_keywords;
      
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
        console.error(`[Apollo] People search HTTP ${res.status} — body:`, await res.text().catch(() => '(unreadable)'));
        return { total_entries: 0, people: [] };
      }
      const data = await res.json();
      console.log(`[Apollo] People search raw response: total=${data.total_entries}, people=${data.people?.length}`);
      
      const people = (data.people || []).filter(p => {
        const n = normalizePerson(p, 'apollo');
        return n.name && n.name.length > 2 && n.title && n.company;
      }).map(p => normalizePerson(p, 'apollo'));

      return { total_entries: data.total_entries || 0, people };
    } catch(e) {
      console.error('[apolloPeopleSearch] exception:', e.message);
      return { total_entries: 0, people: [] };
    }
  };

  // ── STEP 1: Pre-flight company check ──
  if (progressCb) await progressCb({ progress: 10, message: 'Checking the candidate company pool…' });
  const preflight = await preflightCompanyCheck(currentPayload);
  log.push({ step: 'preflight', companiesFound: preflight.companiesFound });

  if (preflight.companiesFound === 0) {
    // Only strip filters that are NOT protected. q_keywords mirrors
    // q_organization_keyword_tags (set by sanitizeApolloPayload), so if industry
    // is protected we leave q_keywords alone too — they carry the same signal.
    if (currentPayload.q_keywords && !protectedFilters.has('q_organization_keyword_tags')) {
      log.push({ step: 'relax', action: 'removed', filter: 'q_keywords', before: currentPayload.q_keywords, after: null, reason: 'preflight_zero_companies' });
      delete currentPayload.q_keywords;
    }
    if (currentPayload.organization_num_employees_ranges) {
      log.push({ step: 'relax', action: 'removed', filter: 'organization_num_employees_ranges', before: [...currentPayload.organization_num_employees_ranges], after: null, reason: 'preflight_zero_companies' });
      delete currentPayload.organization_num_employees_ranges;
    }
    if (currentPayload.revenue_range) {
      log.push({ step: 'relax', action: 'removed', filter: 'revenue_range', before: currentPayload.revenue_range, after: null, reason: 'preflight_zero_companies' });
      delete currentPayload.revenue_range;
    }
  }

  // ── STEP 2: Initial people search ──
  if (progressCb) await progressCb({ progress: 20, message: 'Running initial Apollo search…' });
  let results = await apolloPeopleSearch(currentPayload);
  log.push({ step: 'initial_search', totalResults: results.total_entries, filtersUsed: Object.keys(currentPayload) });
  if (progressCb) await progressCb({ progress: 30, message: `Initial search: ${results.total_entries.toLocaleString()} contacts` });

  // ── STEP 3: Progressive relaxation loop ──
  let relaxIdx = 0;

  while (results.total_entries < MIN_LEADS && attempt < MAX_ATTEMPTS) {
    attempt++;

    let filterToRelax = null;
    while (relaxIdx < relaxationOrder.length) {
      const candidate = relaxationOrder[relaxIdx];
      relaxIdx++;
      // Skip protected filters — never auto-strip geography or industry keyword.
      if (protectedFilters.has(candidate)) {
        log.push({ step: 'skip_protected', attempt, filter: candidate });
        continue;
      }
      if (currentPayload[candidate] !== undefined) {
        filterToRelax = candidate;
        break;
      }
    }

    if (!filterToRelax) {
      // Nuclear fallback — keep titles + any protected filters (geo and/or industry)
      const nuclear = {
        person_titles: currentPayload.person_titles,
        per_page: 25
      };
      if (currentPayload.organization_locations) nuclear.organization_locations = currentPayload.organization_locations;
      if (currentPayload.person_locations) nuclear.person_locations = currentPayload.person_locations;
      // Preserve industry keyword tag through the nuclear path when protected.
      if (protectedFilters.has('q_organization_keyword_tags') && currentPayload.q_organization_keyword_tags) {
        nuclear.q_organization_keyword_tags = currentPayload.q_organization_keyword_tags;
      }

      currentPayload = nuclear;
      log.push({ step: 'nuclear_fallback', attempt });
      results = await apolloPeopleSearch(currentPayload);
      break;
    }

    const r = relaxFilter(currentPayload, filterToRelax);
    log.push({ step: 'relax', attempt, filter: filterToRelax, action: r.action, before: r.before, after: r.after });
    if (progressCb) await progressCb({ progress: Math.min(60, 30 + attempt * 5), message: `Broadening ${filterToRelax} (retry ${attempt})…` });

    results = await apolloPeopleSearch(currentPayload);
    log.push({ step: 'search', attempt, totalResults: results.total_entries });
  }

  // The previous "absolute_fallback" step stripped every filter except titles
  // and ran one final search. For tight ICPs this returned millions of unrelated
  // contacts (e.g. tekrisq → 2.5M). 25 random leads from a 2.5M pool look
  // plausible but are not ICP-matched, which is worse than showing zero leads.
  // We now stop after the relaxation loop. If the loop ended with zero results
  // we surface that to the UI as "market too narrow — broaden your ICP" rather
  // than padding with garbage.
  if (results.total_entries < MIN_LEADS) {
    log.push({
      step: 'stopped_short',
      reason: results.total_entries === 0 ? 'no_matches_after_relaxation' : 'partial_results',
      finalResults: results.total_entries
    });
  }

  return {
    leads: results.people?.slice(0, 50) || [],
    totalAvailable: results.total_entries,
    finalPayload: currentPayload,
    relaxationLog: log,
    wasRelaxed: attempt > 0,
    marketTooNarrow: results.total_entries === 0 && attempt > 0
  };
}

async function fetchLeadsFromApollo(icp, progressCb) {
  const APOLLO_KEY = process.env.APOLLO_API_KEY;
  if (!APOLLO_KEY) { console.log('[Apollo] No API key — skipping'); return null; }

  // Build the Apollo search payload from explicit Apollo-native ICP fields only.
  // If a field is missing or empty (e.g. apollo_geography, apollo_employee_ranges,
  // apollo_keyword) we do NOT include it — we'd rather return a larger,
  // less-filtered pool than guess what the rep meant. The free-text company_size
  // string is for the UI; we no longer derive employee ranges from it because the
  // mapping is fragile (e.g. "Independent practitioners to small RIA firms" used
  // to map to "1,10" which is much tighter than the ICP actually implied).
  const rawGeo = Array.isArray(icp?.apollo_geography) && icp.apollo_geography.length ? icp.apollo_geography : null;
  const apolloGeo = rawGeo
    ? rawGeo.flatMap(g => (/^european union$/i.test(g) || /^europe$/i.test(g)) ? EU_COUNTRIES : [g]).filter((g, i, a) => a.indexOf(g) === i)
    : [];

  const sizeRanges = (Array.isArray(icp?.apollo_employee_ranges) && icp.apollo_employee_ranges.length)
    ? icp.apollo_employee_ranges
    : [];

  // apollo_keyword (single free-text phrase, e.g. "property management") is the
  // industry signal. Falls back to legacy apollo_industries[0] for old jobs.
  // If neither is present we send no industry filter at all.
  const keywordPhrase = (typeof icp?.apollo_keyword === 'string' && icp.apollo_keyword.trim())
    ? icp.apollo_keyword.trim()
    : (Array.isArray(icp?.apollo_industries) && icp.apollo_industries.length
        ? String(icp.apollo_industries[0] || '').trim()
        : '');

  // Four core Apollo filters by default: titles, location (account HQ),
  // employee size, industry keyword. person_seniorities is OPT-IN — the
  // extractor (handleExtract) returns null for it, so automated runs never
  // narrow on seniorities. But if the rep manually adds seniority chips in
  // the Edit-Filters UI and saves, those values land in icp.person_seniorities
  // and we honor them here. This matches the chip UI's behavior: visible,
  // editable, but only active when the rep chose to use them.
  // contact_email_status is never added by us — sanitizeApolloPayload strips
  // it anyway. Reps who want a verified-only filter can toggle it manually
  // later; not the default.
  const legacyPayload = { per_page: 50 };
  if (Array.isArray(icp?.apollo_titles) && icp.apollo_titles.length) {
    legacyPayload.person_titles = icp.apollo_titles;
  }
  if (apolloGeo.length)  legacyPayload.organization_locations = apolloGeo;
  if (sizeRanges.length) legacyPayload.organization_num_employees_ranges = sizeRanges;
  if (Array.isArray(icp?.person_seniorities) && icp.person_seniorities.length) {
    legacyPayload.person_seniorities = icp.person_seniorities;
  }
  // Pass the keyword as q_keywords (string). sanitizeApolloPayload normalizes
  // this to a SINGLE-TAG q_organization_keyword_tags, avoiding Apollo's AND-trap.
  if (keywordPhrase) legacyPayload.q_keywords = keywordPhrase;

  // Relaxation order matches the filters we actually send. person_seniorities
  // and person_department_or_subdepartments stay listed (defensive) for jobs
  // whose stored apollo_payload may still include them; the relax loop will
  // simply skip them if they aren't in currentPayload.
  const defaultRelaxationOrder = [
    "revenue_range",
    "currently_using_any_of_technology_uids",
    "organization_num_employees_ranges",
    "q_organization_keyword_tags", // industry phrase — drop early if results are tight
    "q_keywords",                  // fallback name (some translator outputs still use it)
    "person_department_or_subdepartments",
    "organization_locations",
    "person_seniorities",
    "person_titles"
  ];

  // Use apollo_payload from ICP translator only if it has actual query fields.
  // An empty {} object is truthy but would cause Apollo to return 0 results.
  const hasTranslatedPayload = icp.apollo_payload && Object.keys(icp.apollo_payload).length > 0;
  const { payload: sanitizedPayload, warnings } = sanitizeApolloPayload(hasTranslatedPayload ? icp.apollo_payload : legacyPayload);
  if (!hasTranslatedPayload) console.log('[Apollo] apollo_payload empty/missing — using legacyPayload');
  if (warnings.length > 0) console.log('[Apollo] Sanitize warnings:', warnings);

  console.log('[Apollo] sanitizedPayload keys:', Object.keys(sanitizedPayload));
  console.log('[Apollo] sanitizedPayload:', JSON.stringify(sanitizedPayload));
  console.log('[Apollo] Starting v3 guaranteed lead search...');
  const result = await guaranteedLeadSearch(
    sanitizedPayload,
    icp.confidence_map || {},
    icp.relaxation_order || defaultRelaxationOrder,
    progressCb
  );

  console.log(`[Apollo] v3 Search Complete: ${result.leads.length} leads returned. TAM: ${result.totalAvailable}. Was relaxed: ${result.wasRelaxed}`);

  // Adjacent-TAM probe — one extra mixed_people/api_search (free) with the
  // industry-keyword filter stripped. Empirical test showed the keyword tag is
  // typically the single biggest TAM-killer (9× shrink on Ifficient: 12K → 115K
  // without it). Surfacing both numbers lets the rep see what the keyword
  // filter is costing and decide whether to broaden. Best-effort: any failure
  // here is logged but doesn't block the main search result.
  let adjacentTotal = null;
  try {
    const adjacentPayload = { ...(result.finalPayload || sanitizedPayload), per_page: 1 };
    delete adjacentPayload.q_organization_keyword_tags;
    delete adjacentPayload.q_keywords;
    // Only run if the keyword filter actually was applied — otherwise adjacent == strict.
    const stripsKeyword = (result.finalPayload?.q_organization_keyword_tags?.length || result.finalPayload?.q_keywords);
    if (stripsKeyword) {
      const adjRes = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_KEY },
        body: JSON.stringify(adjacentPayload),
        signal: AbortSignal.timeout(10000)
      });
      if (adjRes.ok) {
        const adjData = await adjRes.json();
        adjacentTotal = adjData.total_entries ?? null;
        console.log(`[Apollo] Adjacent TAM (no keyword): ${adjacentTotal}`);
      }
    }
  } catch (e) {
    console.warn('[Apollo] adjacent-TAM probe failed:', e.message);
  }

  // Hydrate website + company LinkedIn via mixed_companies/search (no credit cost).
  // People search strips these fields on this plan tier — without this step the UI
  // shows "—" in the Website and LinkedIn columns even when the data exists in Apollo.
  if (progressCb) await progressCb({ progress: 65, message: 'Hydrating website + company LinkedIn…' });
  await enrichLeadsWithCompanyData(result.leads, progressCb);

  // Expose wasRelaxed and relaxationLog at top level for handleLeadList.
  // wasRelaxed must also be inside `diagnostics` because that's what the
  // frontend checks to decide whether to render the relaxation panel — without
  // it, fresh rerun results never show the diff even when filters were dropped.
  return {
    leads: result.leads,
    total: result.totalAvailable,
    adjacent_total: adjacentTotal,
    tamSource: 'apollo',
    wasRelaxed: result.wasRelaxed,
    relaxationLog: result.relaxationLog,
    finalPayload: result.finalPayload,
    diagnostics: {
      wasRelaxed: result.wasRelaxed,
      relaxationLog: result.relaxationLog,
      finalPayload: result.finalPayload,
      adjacent_total: adjacentTotal
    }
  };
}

// ── Webinar titles generation ─────────────────────────────────────────────────
// Accepts the full job so we can pull brand_data (host's tagline, website summary)
// and research_data.host (founder name + bio) into the per-job context. These are
// available cheaply (already populated by brand_scrape and prospect_research tasks)
// and give Claude meaningfully more material than extracted_data alone.
async function generateWebinarTitles(extracted, companyName, job = null, customInstructions = '') {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const icp = extracted.icp || {};
  const role = icp.role || 'business owners', industry = icp.industry || 'B2B';
  const size = icp.company_size || '', geo = icp.geography;
  // Brief schema uses angle.pain/result; spec schema uses customer_pain/result_delivered — support both
  const pain   = extracted.customer_pain   || extracted.angle?.pain   || 'unpredictable client acquisition';
  const result = extracted.result_delivered || extracted.angle?.result || 'predictable revenue growth';
  // Bridge angle.proof → case_study so the variant schema's proof_story field
  // can populate even when the brief only filled angle.proof (which is the
  // normal extractor output — case_study itself is never written upstream).
  const cs = extracted.case_study || (
    extracted.angle?.proof
      ? { numbers: extracted.angle.proof, result: extracted.angle?.result || null, client_description: null }
      : null
  );
  const brand    = (job && job.brand_data)    || {};
  const research = (job && job.research_data?.host || {});
  const hostName = research.name || extracted.prospect?.name || null;
  const hostBio  = research.bio  || null;
  const tagline  = brand.tagline || null;
  const summary  = brand.website_summary ? brand.website_summary.slice(0, 400) : null;
  // What the prospect actually sells — website-grounded, populated by the brief
  // extractor from transcript + scraped site copy. This is the single strongest
  // anchor against "QS-pitch contamination": when angle.result was polluted by
  // the rep's pitch (cold outbound / pipeline / webinar acquisition), this field
  // still describes the prospect's REAL product (e.g. "time-tracking and billing
  // SaaS for service businesses"). Feed it to Claude verbatim near the top of
  // the job context so the model anchors the webinar topic in the prospect's
  // actual business, not the language the rep used during Call 1.
  const offerDesc  = extracted.prospect?.offer_description
                     || (brand.website_summary ? brand.website_summary.slice(0, 400) : null)
                     || null;
  const offerName  = extracted.prospect?.offering_name || null;
  // Business model — gates the webinar framing. Consulting/coaching/agency hosts
  // get "educational" copy (we teach you how to build X). managed_service /
  // lead_gen / saas / platform / product hosts get "delivery" copy (we produce
  // X; you receive it). Mis-classifying a lead-gen vendor as a consultant is
  // the #1 cause of "the copy doesn't match what they actually sell" — the
  // model writes 'Build a performance marketing system' for a pay-per-lead
  // vendor whose actual pitch is 'We deliver leads on CPA.'
  const businessModel = String(extracted.prospect?.business_model || 'unknown').toLowerCase();
  const EDUCATIONAL_MODELS = new Set(['consulting', 'coaching', 'agency']);
  const DELIVERY_MODELS    = new Set(['managed_service', 'lead_gen', 'saas', 'platform', 'product']);
  const modelFramingHint = EDUCATIONAL_MODELS.has(businessModel)
    ? `EDUCATIONAL host (${businessModel}) — webinar teaches attendees a system they will implement. Bullets = transformation promises ("Build X", "Structure Y", "Master Z"). session_promise = "[host] will show you exactly how [client] did this." contrast_frame / urgency_close = "[X] built [new system]" / "They're building [new system]".`
    : DELIVERY_MODELS.has(businessModel)
      ? `DELIVERY host (${businessModel}) — webinar describes outcomes the HOST produces; attendees receive results, they do NOT build a system themselves. Bullets = outcome promises ("Receive X", "Hit Y CAC", "Stop spending on Z", "Cut X by 30%", "Unlock Y without managing Z"). session_promise = "[host] delivered [outcome] for [segment] — here's how they can do the same for you" / "[host] will show you what's possible with [product]." contrast_frame = "Instead of [building/managing X yourself], [host] handles it for you." urgency_close = "[Segment] winning aren't building [X] in-house — they're using [host] / outsourcing to [host]." FORBIDDEN for this model: "Build a system", "Structure your X", "Create the framework", "you'll learn how to build", "the X-step process to construct" — those describe what the HOST does internally, not what the attendee experiences.`
      : `UNKNOWN business model — default to DELIVERY framing (safer for non-consulting hosts). Avoid "build a system" / "structure your X" bullets unless the host's offer_description clearly describes a teachable framework.`;
  // Pull richer brief fields for the accuracy-first generation prompt. These
  // drive the specificity hierarchy (Step 5 of webinar_titles_system.txt) so
  // verbatim language wins over generic industry assumptions.
  const verbatim    = extracted.verbatim  || {};
  const situation   = extracted.situation || {};
  const briefContext = extracted.context  || {};
  const apolloTitles = Array.isArray(icp.apollo_titles) ? icp.apollo_titles.filter(Boolean) : [];
  // Classify geography for the compliance-language rules (Step 2). Best-effort
  // hint — the model does the final classification, but a deterministic split
  // for common cases reduces drift. 'other' is the safe default.
  function classifyGeo(g) {
    if (!g) return 'other';
    const s = String(g).toLowerCase();
    if (/\b(usa|united states|us\b|u\.s\.|america)\b/.test(s)) return 'us';
    if (/\b(canada|canadian|qu[eé]bec|ontario|alberta|british columbia)\b/.test(s)) return 'ca';
    return 'other';
  }
  const geoClassHint = classifyGeo(geo);
  const bulletShapeRule = EDUCATIONAL_MODELS.has(businessModel)
    ? "bullets = specific TRANSFORMATION promises (attendee will Build/Structure/Master something)"
    : DELIVERY_MODELS.has(businessModel)
      ? "bullets = specific OUTCOME promises the host delivers (attendee will Receive/Hit/Cut/Stop/Unlock — never Build/Structure/Create)"
      : "bullets = specific promises (default to OUTCOME framing — Receive/Hit/Cut — unless the host's offer_description clearly describes a teachable framework)";
  const outputSchema = `\nRuntime rules: write as ${companyName} hosting — NEVER as Quantum Scaling • titles HARD LIMIT 60 chars, NO emojis in titles • ${bulletShapeRule} • ${cs?.numbers ? 'proof numbers verbatim: ' + cs.numbers : 'no fabricated proof numbers — set proof_story to null if no numbers in brief'} • return ALL 12 fields per variant + _score per variant + top-level _analysis and _recommended_index\nReturn valid JSON only matching the Output Format schema above.`;
  let systemPrompt, userPrompt;
  let brainMeta = null;
  if (WEBINAR_SYSTEM_TEMPLATE) {
    // Per-job context (extracted_data + brand_data + research_data + verbatim
    // quotes + situation + context). The 8-section accuracy framework in
    // webinar_titles_system.txt reads these lines to do audience separation,
    // geography classification, and claim anchoring.
    const jobContext = [
      `- Host (company sending the invite): ${companyName}`,
      // Anchor what the host ACTUALLY sells, BEFORE pain/result lines. This is
      // the single strongest defense against the model writing a webinar about
      // the sales rep's pitch instead of the prospect's real product. If
      // offer_description is filled, the webinar topic MUST orbit it.
      offerDesc ? `- *** WHAT THE HOST ACTUALLY SELLS (anchor the webinar topic here — this overrides any 'pain' or 'result' field that contradicts it): ${offerDesc}` : null,
      offerName ? `- Host's product/methodology name: ${offerName}` : null,
      // Business model gates the entire copy SHAPE. Without this, the model
      // defaults to "consultant teaches audience to build a system" framing,
      // which is wrong for managed-service / lead-gen / SaaS hosts whose
      // actual pitch is "we deliver outcomes; you don't build anything."
      `- *** HOST BUSINESS MODEL: ${businessModel} — ${modelFramingHint}`,
      tagline    ? `- Host tagline: ${tagline}` : null,
      hostName   ? `- Host founder: ${hostName}${hostBio ? ' — ' + hostBio : ''}` : null,
      `- Attendee (host's ICP — the reader of this calendar invite): ${role}${size ? ' at ' + size + ' companies' : ''}${industry ? ' in ' + industry : ''}`,
      apolloTitles.length ? `- Attendee titles (verbatim): ${apolloTitles.slice(0, 8).join(', ')}` : null,
      geo ? `- Geography: ${geo} → geography_class hint: ${geoClassHint}` : `- Geography: not specified → geography_class hint: other`,
      `- Attendee's core pain (the prospect's CUSTOMER pain — not the prospect's own marketing pain): ${pain}`,
      `- Attendee's desired outcome (what the prospect's CUSTOMER wants): ${result}`,
      verbatim.pain_quote   ? `- VERBATIM PAIN QUOTE (use exact words where possible): "${verbatim.pain_quote}"` : null,
      verbatim.result_quote ? `- VERBATIM RESULT QUOTE: "${verbatim.result_quote}"` : null,
      verbatim.goal_quote   ? `- VERBATIM GOAL QUOTE (aspiration — NOT current state): "${verbatim.goal_quote}"` : null,
      situation.current_lead_gen ? `- Attendee's current acquisition channels: ${situation.current_lead_gen}` : null,
      situation.revenue_range    ? `- Attendee's CURRENT revenue (state — NOT goal): ${situation.revenue_range}` : null,
      briefContext.goals         ? `- Attendee's stated goals (aspiration): ${briefContext.goals}` : null,
      cs?.numbers ? `- Client proof (use VERBATIM): ${cs.client_description || 'A client'} — ${cs.result || ''} (${cs.numbers})` : '- Client proof: none in brief → proof_story MUST be null in all variants',
      (extracted.webinar_angle || briefContext.why_webinar) ? `- Webinar angle / why this webinar: ${extracted.webinar_angle || briefContext.why_webinar}` : null,
      summary ? `- Host website summary (positioning context, not for verbatim quoting): ${summary}` : null,
      // Hard anti-pattern fence — written here (not just in the system prompt)
      // because the strongest place to prevent contamination is right next to
      // the prospect's actual offer description.
      `- AUDIENCE FENCE: The reader of this invite is the PROSPECT'S CUSTOMER, not the prospect themselves. NEVER describe the host's product as "webinar acquisition", "lead-gen system", "pipeline management", "cold outbound replacement", "9-15 week onboarding", "HubSpot integration", "$500M+ revenue", or "1,400+ clients" — those phrases describe Quantum Scaling's pitch to the prospect, NOT what the prospect sells. If you find yourself writing them in the hook, bullets, or proof, you have inverted the audience and must rewrite using ONLY the "WHAT THE HOST ACTUALLY SELLS" line above.`,
      // Business-model fence — prevents the second-order failure mode: copy
      // that's no longer QS-pitch contaminated, but still wrong-shaped (e.g.
      // pitching a managed-service vendor as if they were a consultant
      // teaching their ICP how to build a system).
      DELIVERY_MODELS.has(businessModel) ? `- BUSINESS-MODEL FENCE: This host is a ${businessModel} (delivery model — they produce outcomes, attendees receive them). FORBIDDEN bullet/title verbs: Build, Structure, Construct, Create the framework, Master the X-step process, Develop the system. ALLOWED verbs: Receive, Hit, Reach, Cut, Stop, Eliminate, Unlock, Get [outcome] without [work the host does for them]. session_promise must commit to delivering an outcome, NOT to revealing a teachable system.` : null
    ].filter(Boolean).join('\n');
    var brain = await loadCopyBrain();
    brainMeta = brain._meta;
    const businessContextBlock = `### Per-Job Context\n${jobContext}\n\n### Universal Brain\n${brain.business_context_block}`;
    systemPrompt = interpolate(WEBINAR_SYSTEM_TEMPLATE, {
      prospect_company_name: companyName, icp_role: role, icp_industry: industry,
      business_context_block: businessContextBlock,
      format_rules_block:    brain.format_rules_block,
      principles_block:      brain.principles_block,
      examples_block:        brain.examples_block,
    }) + outputSchema;
    userPrompt = interpolate(WEBINAR_USER_TEMPLATE, {
      prospect_company_name: companyName, icp_role: role, icp_company_size: size, icp_industry: industry,
      icp_geography_line:   geo ? `\n**Geography:** ${geo}` : '',
      customer_pain: pain, result_delivered: result,
      case_study_block:    cs?.result ? `**Client proof:** ${cs.client_description || 'A client'} — ${cs.result}${cs.numbers ? ' (' + cs.numbers + ')' : ''}` : '',
      webinar_angle_block: (extracted.webinar_angle || extracted.context?.why_webinar) ? `**Webinar angle:** ${extracted.webinar_angle || extracted.context?.why_webinar}` : ''
    });
  } else {
    systemPrompt = `You are a direct-response copywriter writing calendar blocker copy for ${companyName}'s webinar targeting ${role}s in ${industry}. Write as ${companyName} hosting — never as Quantum Scaling. Return valid JSON only.` + outputSchema;
    userPrompt   = `Generate 3 calendar blocker variants for ${companyName}'s webinar targeting ${role}s in ${industry}${size ? ' (' + size + ' companies)' : ''}.\nPain: ${pain}\nResult: ${result}`;
  }
  // Rep-supplied regeneration instructions (from the Calendar Invite tab's chat
  // input). Appended last so they override any framing above without forcing the
  // model to re-derive context. Capped at 800 chars upstream.
  const repInstructions = (customInstructions || '').toString().trim();
  if (repInstructions) {
    userPrompt += `\n\n### Rep instructions (apply these — overrides anything above)\n${repInstructions.slice(0, 800)}`;
    console.log(`[webinar_titles] Rep instructions applied: "${repInstructions.slice(0, 120)}${repInstructions.length > 120 ? '…' : ''}"`);
  }
  console.log('[webinar_titles] Calling Claude Sonnet...');
  // max_tokens raised from 3000 → 4000 to accommodate the new top-level
  // _analysis block + per-variant _score object on top of the 12-field schema.
  // Empirically the analysis adds ~350 tokens and per-variant scores ~150 more,
  // and we don't want truncation cutting off the last variant or the closing brace.
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 4000, temperature: 0.7,
    system: systemPrompt, messages: [{ role: 'user', content: userPrompt }]
  });
  const raw = message.content[0].text;
  let parsed;
  parsed = extractJsonObject(raw);
  if (!parsed) throw new Error('webinar_titles: unparseable JSON');
  // Defensive alias normalization — Claude sometimes uses the wrong top-level key
  // (calendar_blockers / invites / titles / options) because the prompt narrative
  // historically referred to "calendar blocker copy". If `variants` is missing
  // but a same-shape array exists under a known alias, lift it into `variants`
  // and log so we can track frequency. The prompt has been tightened too — this
  // is a belt-and-suspenders guard for residual model variability.
  if (!Array.isArray(parsed.variants) || parsed.variants.length === 0) {
    const aliases = ['calendar_blockers', 'invites', 'titles', 'options', 'webinar_invites'];
    for (const alias of aliases) {
      if (Array.isArray(parsed[alias]) && parsed[alias].length > 0) {
        console.warn(`[webinar_titles] Aliased "${alias}" → "variants" (model returned wrong top-level key)`);
        parsed.variants = parsed[alias];
        delete parsed[alias];
        break;
      }
    }
    if (!Array.isArray(parsed.variants) || parsed.variants.length === 0) {
      throw new Error('webinar_titles: response missing required "variants" array (got keys: ' + Object.keys(parsed).slice(0, 6).join(', ') + ')');
    }
  }
  // Per-variant shape guard — fails the task immediately if Claude returns the
  // legacy 4-field schema (`{title, hook, description, for_line}`) instead of
  // the 12-field schema in specs/webinar_titles.md §5. No retry: a silent
  // retry would mask the regression. A thrown error surfaces on the Render
  // dashboard and in `tasks.error_message` the moment it happens, so the
  // root cause (usually a regression in the examples_block teaching the wrong
  // shape) gets fixed instead of hidden.
  const REQUIRED_VARIANT_FIELDS = ['title', 'conditional_opener', 'rsvp_block', 'bullets', 'for_line'];
  parsed.variants.forEach((v, i) => {
    if (!v || typeof v !== 'object') {
      throw new Error(`webinar_titles: variant ${i} is not an object`);
    }
    const missing = REQUIRED_VARIANT_FIELDS.filter(f => v[f] == null);
    const looksLegacy = typeof v.description === 'string' && v.description.trim().length > 0;
    if (missing.length || looksLegacy) {
      throw new Error(
        `webinar_titles: variant ${i} returned in legacy/incomplete shape ` +
        `(missing: ${missing.join(',') || 'none'}; legacy_description: ${looksLegacy}). ` +
        `Re-check loadCopyBrain.examplesBlock — model is being taught the wrong shape.`
      );
    }
    if (!Array.isArray(v.bullets) || v.bullets.length < 3) {
      throw new Error(
        `webinar_titles: variant ${i} bullets must be an array of 4-5 strings ` +
        `(got: ${Array.isArray(v.bullets) ? 'array length ' + v.bullets.length : typeof v.bullets})`
      );
    }
  });
  // Validate _recommended_index. The prompt asks Claude to compute it from the
  // highest _score.total. If it's missing or out of range we fall back: pick
  // the variant with the highest score.total ourselves, defaulting to 0.
  function deriveRecommendedIndex() {
    const variants = parsed.variants || [];
    let bestIdx = 0, bestTotal = -1;
    variants.forEach((v, i) => {
      const total = (v && v._score && typeof v._score.total === 'number') ? v._score.total : -1;
      if (total > bestTotal) { bestTotal = total; bestIdx = i; }
    });
    return bestIdx;
  }
  if (typeof parsed._recommended_index !== 'number' || parsed._recommended_index < 0 || parsed._recommended_index > 2) {
    const derived = deriveRecommendedIndex();
    console.log(`[webinar_titles] _recommended_index missing/invalid (was ${JSON.stringify(parsed._recommended_index)}) — derived ${derived} from variant scores`);
    parsed._recommended_index = derived;
  }
  // Attach brain meta + generation timestamp + the new accuracy fields so the
  // portal can render "Brain · N principles · K examples · confidence X/10"
  // and a risk-flag warning row in edit mode. _analysis is also preserved at
  // the top level for any downstream consumer that wants it raw.
  const analysis = parsed._analysis || {};
  parsed._meta = {
    ...(parsed._meta || {}),
    brain: brainMeta || { principles_count: 0, fallback: true },
    generated_at: new Date().toISOString(),
    inputs: {
      has_case_study: !!(cs && cs.numbers),
      has_host_bio:   !!hostBio,
      has_brand_tagline: !!tagline,
      has_website_summary: !!summary,
      has_pain_quote: !!verbatim.pain_quote,
      has_goal_quote: !!verbatim.goal_quote,
    },
    analysis,
    recommended_index: parsed._recommended_index,
    confidence: typeof analysis.confidence === 'number' ? analysis.confidence : null,
    risk_flags: Array.isArray(analysis.risk_flags) ? analysis.risk_flags : [],
  };
  return parsed;
}

// ── ROI model math ────────────────────────────────────────────────────────────
function parseLtv(s) {
  if (typeof s === 'number') return s;
  if (!s) return null;
  const clean = s.toString().replace(/[$,\s]/g, '').toUpperCase();
  const match = clean.match(/^([\d.]+)([KM]?)$/);
  if (!match) return null;
  let val = parseFloat(match[1]);
  if (match[2] === 'K') val *= 1000;
  if (match[2] === 'M') val *= 1000000;
  return isNaN(val) ? null : val;
}
function parseRate(s, defaultVal) {
  if (!s) return defaultVal;
  const n = parseFloat(s.toString().replace('%', ''));
  if (isNaN(n)) return defaultVal;
  return n > 1 ? n / 100 : n;
}
function calcRoiProjections(ltv, closeRate, showRate) {
  // Phase 1 params
  const p1 = { prospects: 7500, reg: 0.005, attend: 0.35, book: 0.08 };
  // Phase 2 params
  const p2 = { prospects: 50000, reg: 0.008, attend: 0.50, book: 0.18 };
  const show1 = showRate, close1 = closeRate;
  const show2 = Math.min(showRate + 0.14, 1.0), close2 = Math.min(closeRate + 0.04, 1.0);
  const rev1 = p1.prospects * p1.reg * p1.attend * p1.book * show1 * close1 * ltv;
  const rev2 = p2.prospects * p2.reg * p2.attend * p2.book * show2 * close2 * ltv;
  const revRamp = (rev1 + rev2) / 2;
  // Webinar schedule: bi-weekly starting week 5
  // Phase 1: weeks 5,7,9,11 → 4 webinars
  // Ramp: weeks 13,15,17,19 → 4 webinars
  // Phase 2: weeks 21,23,... → bi-weekly
  function totalRevenue(maxWeeks) {
    let total = 0;
    for (let w = 5; w <= maxWeeks; w += 2) {
      if (w <= 12)        total += rev1;
      else if (w <= 20)   total += revRamp;
      else                total += rev2;
    }
    return Math.round(total);
  }
  return {
    revenue_6mo:  totalRevenue(26),
    revenue_12mo: totalRevenue(52),
    revenue_24mo: totalRevenue(104),
    rev1_per_webinar: Math.round(rev1),
    rev2_per_webinar: Math.round(rev2)
  };
}

// ── Load a prompt from DB by slug, with hardcoded fallback ───────────────────
async function loadPromptFromDB(slug, fallback) {
  try {
    const r = await supabaseRequest('GET', `/rest/v1/prompts?slug=eq.${encodeURIComponent(slug)}&limit=1`);
    if (r?.body?.[0]?.content) {
      console.log(`[prompts] Loaded "${slug}" from DB`);
      return r.body[0].content;
    }
  } catch(e) {
    console.warn(`[prompts] Could not load "${slug}" from DB, using fallback:`, e.message);
  }
  return fallback;
}

// ── Calendar visual: reminder emails ─────────────────────────────────────────
async function generateReminderEmails(title, hostName, resultDelivered, customerPain, prospectCompany) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const fallback = `You are writing short reminder email previews for a webinar registration confirmation sequence. Return valid JSON only. No markdown.

Generate 3 reminder email previews for this webinar:

Webinar title: ${title}
Host name: ${hostName}
What attendees will learn: ${resultDelivered || 'practical strategies'}
Who this is for: ${customerPain || 'business owners looking to grow'}
Prospect company being served: ${prospectCompany || 'the attendee\'s firm'}

Requirements:
- Email 1 (1 week before): Confirm registration, build excitement, reference what they will specifically learn
- Email 2 (24 hours before): Create urgency, mention host opens room early
- Email 3 (1 hour before): Very punchy, 1-2 sentences max

Return this exact JSON:
{"emails":[{"timing":"1 week before","subject":"string — max 10 words","preview":"string — 2-3 sentences, reference the webinar topic specifically"},{"timing":"24 hours before","subject":"string — max 10 words","preview":"string — 2-3 sentences, create urgency"},{"timing":"1 hour before","subject":"string — max 10 words","preview":"string — 1-2 sentences, very punchy"}]}`;
  const promptText = await loadPromptFromDB('email_reminder', fallback);
  const userContent = promptText
    .replace(/\{\{webinar_title\}\}/g, title || '')
    .replace(/\{\{host_name\}\}/g, hostName || '')
    .replace(/\{\{result_delivered\}\}/g, resultDelivered || 'practical strategies')
    .replace(/\{\{customer_pain\}\}/g, customerPain || 'business owners looking to grow')
    .replace(/\{\{prospect_company\}\}/g, prospectCompany || 'the attendee\'s firm');
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 700, temperature: 0.7,
    messages: [{ role: 'user', content: userContent }]
  });
  const raw = msg.content[0].text;
  return extractJsonObject(raw);
}

// ── TASK HANDLERS ─────────────────────────────────────────────────────────────

// ── Phase 3: Read approved calls from DB before hitting Fireflies API ────────
async function findApprovedCallsFromDB(email) {
  if (!email) return [];
  try {
    const r = await supabaseRequest(
      'GET',
      `/rest/v1/calls?status=eq.approved&order=date.desc&limit=20`,
      null,
      { 'Accept-Profile': 'public' }
    );
    if (r.status !== 200 || !Array.isArray(r.body)) return [];
    // Filter client-side: attendee email must match
    const emailLower = email.toLowerCase();
    const matched = r.body.filter(call => {
      let att = call.attendees || [];
      if (typeof att === 'string') { try { att = JSON.parse(att); } catch(e) { att = []; } }
      return att.some(a => (a.email || '').toLowerCase() === emailLower);
    });
    console.log(`[extract] DB approved calls for ${email}: ${matched.length} found`);
    return matched;
  } catch(e) {
    console.warn('[extract] findApprovedCallsFromDB error:', e.message);
    return [];
  }
}

// Convert a DB call row into the same shape handleExtract expects from Fireflies
function dbCallToTranscript(call) {
  let summary = call.summary || {};
  if (typeof summary === 'string') { try { summary = JSON.parse(summary); } catch(e) { summary = {}; } }
  return {
    id:         call.id,
    title:      call.title || '(untitled)',
    duration:   call.duration || 0,
    dateString: call.date ? new Date(call.date).toLocaleDateString('en-US') : '',
    summary
  };
}

async function handleExtract(task, job) {
  const email = job.prospect_email || '';
  const defaultDomain = job.prospect_website || email.split('@')[1];
  const contactInfo = {
    name:    job.prospect_name    || null,
    company: job.prospect_company || null,
    website: defaultDomain        || null
  };
  console.log(`[extract] Processing job ${job.id} for ${email}`);

  // Step 1: transcript source — approved calls from DB first, live Fireflies as fallback
  let transcripts = [];
  let transcriptSource = 'none';

  const dbApproved = await findApprovedCallsFromDB(email);
  if (dbApproved.length > 0) {
    transcripts = dbApproved.map(dbCallToTranscript);
    transcriptSource = 'db_approved';
    console.log(`[extract] Using ${transcripts.length} approved DB call(s) for ${email}`);
  } else {
    transcripts = await findFirefliesTranscripts(email);
    transcriptSource = transcripts.length > 0 ? 'live_fireflies' : 'none';
    console.log(`[extract] DB approved: 0 — falling back to live Fireflies (${transcripts.length} found)`);
  }

  const transcriptFound = transcripts.length > 0;

  // Step 2: Website
  const website = await scrapeWebsite(defaultDomain);

  // Step 3: Build extraction content — aggregate ALL call summaries into one block
  const parts = [];

  if (transcripts.length) {
    transcripts.forEach((transcript, idx) => {
      const s = transcript.summary || {};
      const label = transcripts.length > 1 ? `CALL ${idx + 1} OF ${transcripts.length}` : 'CALL';
      parts.push([
        `${label}: ${transcript.title} (${(transcript.duration || 0).toFixed(0)} min)`,
        s.shorthand_bullet ? `DETAILED NOTES:\n${s.shorthand_bullet}` : '',
        s.overview         ? `METRICS OVERVIEW:\n${s.overview}` : '',
        s.short_summary    ? `SUMMARY:\n${s.short_summary}` : '',
        s.action_items     ? `ACTION ITEMS:\n${s.action_items}` : ''
      ].filter(Boolean).join('\n\n'));
    });
  }

  if (website.bodyText || website.title) {
    parts.push([
      `WEBSITE (${defaultDomain}):`,
      website.title    ? `Title: ${website.title}` : '',
      website.metaDesc ? `Description: ${website.metaDesc}` : '',
      website.bodyText ? `Content:\n${website.bodyText}` : ''
    ].filter(Boolean).join('\n'));
  }
  // Always include domain-derived name as anchor for Claude
  const domainAnchor = defaultDomain.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  parts.unshift(`DOMAIN: ${defaultDomain}\nDERIVED NAME FROM DOMAIN: ${domainAnchor}\n(Use this as the company name if a clearer branded name is not found in the content below)`);

  if (!parts.length) parts.push(`Prospect email: ${email}\nDomain: ${defaultDomain}`);

  // Step 4: Claude extraction (extractBriefFromTranscript is the only extractor defined)
  const extracted = await extractBriefFromTranscript(parts.join('\n\n---\n\n'), website.bodyText || '', contactInfo);

  // Company name cleanup: vague descriptions → use domain
  if (extracted.prospect) {
    const rawCompany = (extracted.prospect.company || '').trim();
    const isVague = rawCompany.split(/\s+/).length > 2 ||
                    /name not provided|not (given|stated|mentioned|found)|unknown|n\/a/i.test(rawCompany) ||
                    /^(a |the )?(boutique|management|project|consulting|advisory|professional|services?|company|firm|business|organization|agency)\b/i.test(rawCompany);
    if (isVague) {
      extracted.prospect.company = domainAnchor;
      console.log(`[extract] Company cleanup: "${rawCompany}" → "${domainAnchor}"`);
    }
  }

  // Embed transcript + website meta into extracted
  const firstT = transcripts[0] || null;
  extracted._meta = {
    transcript: firstT
      ? {
          id:          firstT.id,
          title:       firstT.title,
          date:        firstT.dateString,
          found:       true,
          source:      transcriptSource,
          count:       transcripts.length,
          // Full list of transcripts that fed this brief — surfaced in the Source
          // Intelligence panel so the rep can click through to Fireflies and verify.
          transcripts: transcripts.map(t => ({
            id:       t.id,
            title:    t.title || '(untitled)',
            date:     t.dateString || null,
            duration: t.duration || 0
          }))
        }
      : { found: false, source: 'none' },
    website: { domain: defaultDomain, title: website.title, scraped: !!(website.bodyText) }
  };

  // Merge the fresh extraction into the rep-confirmed brief so Step 2 edits
  // survive the worker pass. Without this, a Claude rerun that returns null
  // for contact_title / offer_description / ICP / metrics / etc. silently
  // clobbers values the rep just confirmed (B6 fix — Prospect Infos was
  // showing blank Contact title because this re-extract overwrote it).
  const existingBrief = job.extracted_data || null;
  const merged        = mergeBrief(existingBrief, extracted);

  // Update prospect_company on the job row. Use merged values so the row
  // mirrors what's in the brief (and what the rep saw).
  const company = merged.prospect?.company || contactInfo.company || defaultDomain;
  await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${job.id}`, {
    prospect_company: company,
    prospect_name:    merged.prospect?.contact_name || contactInfo.name || null,
    updated_at:       new Date().toISOString()
  });
  await updateJobExtractedData(job.id, merged);

  return { extracted: merged, transcriptFound, transcriptSource, websiteScraped: !!(website.bodyText), company };
}

async function handleProspectResearch(task, job) {
  const linkedinUrl = job.prospect_linkedin_url;
  console.log(`[prospect_research] ${linkedinUrl ? 'Scraping ' + linkedinUrl : 'No LinkedIn URL — completing with null'}`);

  if (!linkedinUrl) {
    await updateJobResearchData(job.id, { host: { name: null, title: null, bio: null, headshot_url: null, linkedin_url: null }, scraped: false });
    return { host: null, scraped: false };
  }

  try {
    // LinkedIn profile via Apify — harvestapi/linkedin-profile-scraper (LpVuK3Zozwuipa5bp)
    // Confirmed working: input key is 'urls' (not 'profileUrls')
    // Output schema: firstName, lastName, headline, about, profilePicture/photo
    const items = await runApifyActor('LpVuK3Zozwuipa5bp', {
      urls: [linkedinUrl]
    }, 90000);

    const profile = items?.[0];
    if (!profile) {
      console.warn('[prospect_research] Apify returned no profile');
      await updateJobResearchData(job.id, { host: { name: null, title: null, bio: null, headshot_url: null, linkedin_url: linkedinUrl }, scraped: false });
      return { host: null, scraped: false };
    }

    // Normalise field names — harvestapi uses firstName + lastName (no combined fullName)
    const fullName = (profile.firstName && profile.lastName)
      ? `${profile.firstName} ${profile.lastName}`.trim()
      : (profile.fullName || profile.name || null);
    const headline = profile.headline || profile.title || null;
    const photo    = profile.profilePicture || profile.photo || profile.photoUrl || null;
    const summary  = profile.about || profile.summary || '';

    if (!fullName) {
      console.warn('[prospect_research] Apify profile missing name:', JSON.stringify(profile).slice(0,200));
      await updateJobResearchData(job.id, { host: { name: null, title: null, bio: null, headshot_url: null, linkedin_url: linkedinUrl }, scraped: false });
      return { host: null, scraped: false };
    }

    // Use Claude Haiku to write a short professional bio
    let bio = null;
    if (headline) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 300, temperature: 0,
        system: 'You are writing a short professional bio for a webinar host. Write in third person. 2–3 sentences maximum. Confident and credible tone. Focus on their expertise and who they help. Do not mention the webinar.',
        messages: [{ role: 'user', content: `Write a short host bio from this LinkedIn data:\n\nName: ${fullName}\nHeadline: ${headline}\nSummary: ${summary}\n\nReturn only the bio text. No labels, no markdown.` }]
      });
      bio = msg.content[0].text.trim();
    }

    const researchData = {
      host: {
        name:         fullName,
        title:        headline || null,
        bio,
        headshot_url: photo || null,
        linkedin_url: linkedinUrl
      },
      scraped: true
    };
    await updateJobResearchData(job.id, researchData);
    console.log(`[prospect_research] Done via Apify: name=${fullName}, headshot=${!!photo}, bio=${!!bio}`);
    return researchData;
  } catch(e) {
    console.warn('[prospect_research] Apify failed:', e.message);
    await updateJobResearchData(job.id, { host: { name: null, title: null, bio: null, headshot_url: null, linkedin_url: linkedinUrl }, scraped: false });
    return { host: null, scraped: false };
  }
}

// ── Image-based color extraction — extract dominant colors from an image URL ──
async function extractColorsFromImage(imageUrl) {
  try {
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return [];
    const buffer = Buffer.from(await response.arrayBuffer());
    const { data } = await sharp(buffer)
      .resize(50, 50, { fit: 'cover' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Count quantized color frequencies
    const colorCounts = {};
    for (let i = 0; i < data.length; i += 3) {
      const r = Math.round(data[i] / 16) * 16;
      const g = Math.round(data[i+1] / 16) * 16;
      const b = Math.round(data[i+2] / 16) * 16;
      const hex = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
      colorCounts[hex] = (colorCounts[hex] || 0) + 1;
    }

    // Filter out near-white, near-black, near-gray
    const isNearNeutral = (hex) => {
      const r = parseInt(hex.slice(1,3), 16);
      const g = parseInt(hex.slice(3,5), 16);
      const b = parseInt(hex.slice(5,7), 16);
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      if (saturation < 0.15 && (max > 200 || max < 50)) return true; // near white/black/gray
      return false;
    };

    return Object.entries(colorCounts)
      .sort((a, b) => b[1] - a[1])
      .filter(([hex]) => !isNearNeutral(hex))
      .slice(0, 3)
      .map(([hex]) => hex);
  } catch(e) {
    console.warn('[extractColorsFromImage] error:', e.message);
    return [];
  }
}

async function handleBrandScrape(task, job) {
  const website = job.prospect_website;
  console.log(`[brand_scrape] ${website ? 'Scraping ' + website : 'No website — completing with null'}`);

  const nullOutput = { logo_url: null, favicon_url: null, primary_color: null, secondary_color: null, accent_color: null, all_colors: [], tagline: null, company_name: null, website_summary: null, font_family: null, images: [], scraped: false, source: 'none' };

  if (!website) {
    await updateJobBrandData(job.id, nullOutput);
    return nullOutput;
  }

  const domain = website.replace(/^https?:\/\//, '').replace(/\/$/, '');

  // Use existing scrapeWebsite() — already runs Jina + raw HTML in parallel, no extra cost
  let scraped = { html: '', bodyText: '', title: '', metaDesc: '' };
  try { scraped = await scrapeWebsite(domain); }
  catch(e) { console.warn('[brand_scrape] scrapeWebsite failed:', e.message); }

  const html     = scraped.html     || '';
  const bodyText = scraped.bodyText || '';

  if (!html && !bodyText) {
    await updateJobBrandData(job.id, { ...nullOutput, scraped: false });
    return nullOutput;
  }

  // ── 1. LOGO: 4-path waterfall ────────────────────────────────────────────────
  const resolveUrl = (src) => {
    if (!src) return null;
    src = src.split(' ')[0].trim();
    if (src.startsWith('http')) return src;
    if (src.startsWith('//'))   return 'https:' + src;
    if (src.startsWith('/'))    return `https://${domain}${src}`;
    return `https://${domain}/${src}`;
  };

  let logoUrl = null;

  // Path 1 — Explicit "logo" intent in HTML: <img> / <source> tags with the word
  // "logo" in src / alt / class / id. Demoted from old Path 2 because og:image
  // is unreliable as a logo source (many sites use it for hero banners or
  // lead-magnet covers — e.g. 4fp.co serves a 1200×630 "Devoted Client
  // Attraction Method" banner via og:image, which is wrong for a brand mark).
  const logoPatterns = [
    /<img[^>]+(?:class|id|alt)=["'][^"']*logo[^"']*["'][^>]+src=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+)["'][^>]+(?:class|id|alt)=["'][^"']*logo[^"']*["']/i,
    /<img[^>]+src=["']([^"']*logo[^"'"]*)["']/i,
    /<source[^>]+srcset=["']([^"']*logo[^"'"]+\.(?:png|svg|webp|jpg)[^"' ]*)["' ]/i,
  ];
  for (const p of logoPatterns) {
    const m = html.match(p);
    if (m?.[1]) { logoUrl = resolveUrl(m[1]); break; }
  }

  // Path 2 — High-res square icons (Apple touch icon / sized rel=icon). These
  // are explicitly designed to be square brand marks at avatar-friendly sizes.
  if (!logoUrl) {
    const iconMatch =
      html.match(/<link[^>]+rel=["']apple-touch-icon(?:-precomposed)?["'][^>]+href=["']([^"']+)["']/i) ||
      html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon(?:-precomposed)?["']/i) ||
      html.match(/<link[^>]+rel=["']icon["'][^>]+sizes=["'](?:192|180|128|96|64)x\d+["'][^>]+href=["']([^"']+)["']/i);
    if (iconMatch?.[1]) logoUrl = resolveUrl(iconMatch[1]);
  }

  // Path 3 — og:image. Demoted because it's often a wide marketing banner, not
  // a brand mark. Still useful when the site has no proper logo markup.
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                  html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
  if (!logoUrl && ogImage) logoUrl = resolveUrl(ogImage);

  // Path 4 — Google Favicon CDN. Last resort, guaranteed to return something,
  // always square. Also stored separately as `favicon_url` so callers that
  // specifically want a square brand mark for an avatar can prefer that field.
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
  if (!logoUrl) logoUrl = faviconUrl;

  // ── 2. COLORS: 4-path waterfall ──────────────────────────────────────────────
  const isValidColor = (c) => {
    if (!c || !/^#[0-9a-fA-F]{3,8}$/.test(c)) return false;
    // Normalize 3-char hex to 6-char
    let hex = c.replace('#','');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    if (hex.length < 6) return false;
    const r = parseInt(hex.substr(0,2), 16), g = parseInt(hex.substr(2,2), 16), b = parseInt(hex.substr(4,2), 16);
    // Filter near-white (luminance > 0.92) and near-black (luminance < 0.08)
    const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
    if (lum > 0.92 || lum < 0.08) return false;
    // Filter grays with no saturation
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    if ((max - min) < 20) return false;
    return true;
  };
  const allColors = [];
  let primaryColor = null, secondaryColor = null, accentColor = null;

  // Path 1: theme-color meta
  const themeColor =
    html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i)?.[1];
  if (isValidColor(themeColor)) { primaryColor = themeColor; allColors.push(themeColor); }

  // Path 2: CSS variables in inline <style> blocks
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
  const parseCssColors = (css) => ({
    primary:   [...css.matchAll(/--(?:primary|brand-primary|color-primary|theme-primary|main-color|key-color|color-brand)\s*:\s*(#[0-9a-fA-F]{3,8})/gi)].map(m=>m[1]).filter(isValidColor),
    secondary: [...css.matchAll(/--(?:secondary|brand-secondary|color-secondary|theme-secondary)\s*:\s*(#[0-9a-fA-F]{3,8})/gi)].map(m=>m[1]).filter(isValidColor),
    accent:    [...css.matchAll(/--(?:accent|highlight|cta|button-color|action|color-cta|link-color)\s*:\s*(#[0-9a-fA-F]{3,8})/gi)].map(m=>m[1]).filter(isValidColor),
  });
  const inline = parseCssColors(styleBlocks);
  if (!primaryColor   && inline.primary[0])   { primaryColor   = inline.primary[0];   allColors.push(primaryColor); }
  if (!secondaryColor && inline.secondary[0]) { secondaryColor = inline.secondary[0]; allColors.push(secondaryColor); }
  if (!accentColor    && inline.accent[0])    { accentColor    = inline.accent[0];    allColors.push(accentColor); }

  // Path 3: Fetch linked CSS files — KEY FIX for Wix/Webflow/Squarespace
  // Modern builders load all CSS variables from external .css files, never inline.
  if (!primaryColor) {
    const cssLinks = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+\.css[^"']*)["']/gi)]
      .map(m => m[1])
      .map(h => h.startsWith('http') ? h : h.startsWith('//') ? 'https:'+h : `https://${domain}${h.startsWith('/')?h:'/'+h}`)
      .slice(0, 3);
    if (cssLinks.length) {
      const cssTexts = await Promise.all(cssLinks.map(async url => {
        try { const r = await fetch(url, {signal:AbortSignal.timeout(3000)}); return r.ok ? await r.text() : ''; }
        catch { return ''; }
      }));
      const ext = parseCssColors(cssTexts.join('\n'));
      if (!primaryColor   && ext.primary[0])   { primaryColor   = ext.primary[0];   allColors.push(primaryColor); }
      if (!secondaryColor && ext.secondary[0]) { secondaryColor = ext.secondary[0]; allColors.push(secondaryColor); }
      if (!accentColor    && ext.accent[0])    { accentColor    = ext.accent[0];    allColors.push(accentColor); }
      console.log(`[brand_scrape] CSS files: ${cssLinks.length} checked, primary=${primaryColor || 'none'}`);
    }
  }

  // Path 4: Background colors from inline style attributes (last resort)
  if (!primaryColor) {
    const bgMatches = [...html.matchAll(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8})/gi)].map(m=>m[1]).filter(isValidColor);
    if (bgMatches[0]) { primaryColor = bgMatches[0]; allColors.push(bgMatches[0]); }
  }

  // Path 5: Extract dominant colors from hero/og:image pixels (no external API)
  if (!primaryColor) {
    const imgUrl = ogImage ? resolveUrl(ogImage) : null;
    if (imgUrl) {
      try {
        const imgColors = await extractColorsFromImage(imgUrl);
        if (imgColors.length >= 1 && !primaryColor)   { primaryColor   = imgColors[0]; allColors.push(imgColors[0]); }
        if (imgColors.length >= 2 && !secondaryColor)  { secondaryColor = imgColors[1]; allColors.push(imgColors[1]); }
        if (imgColors.length >= 3 && !accentColor)     { accentColor    = imgColors[2]; allColors.push(imgColors[2]); }
        console.log(`[brand_scrape] Image color extraction: ${imgColors.length} colors from og:image`);
      } catch(e) { console.warn('[brand_scrape] Image color extraction failed:', e.message); }
    }
  }

  // ── 3. IMAGE COLLECTION (max 8, typed: hero / team / general) ────────────────
  const images = [];
  const skipImg  = /icon|flag|avatar|pixel|tracking|analytics|sprite|arrow|chevron|placeholder|spacer|blank/i;
  const heroImg  = /hero|banner|header|main|cover|background|bg-|slide/i;
  const teamImg  = /team|people|staff|about|office|founder|headshot|portrait/i;
  const seenImgs = new Set();

  const addImage = (url, alt = '') => {
    if (!url || !url.startsWith('http') || seenImgs.has(url) || skipImg.test(url)) return;
    seenImgs.add(url);
    const sig = (url + ' ' + alt).toLowerCase();
    images.push({ url, alt: alt.slice(0, 100), type: heroImg.test(sig) ? 'hero' : teamImg.test(sig) ? 'team' : 'general' });
  };

  // og:image and twitter:image (highest quality — curated by site owner)
  [...html.matchAll(/<meta[^>]+(?:property=["']og:image["']|name=["']twitter:image["'])[^>]+content=["']([^"']+)["']/gi)]
    .forEach(m => addImage(m[1]));

  // Large or meaningfully-alt'd <img> tags
  [...html.matchAll(/<img([^>]+)>/gi)].forEach(m => {
    if (images.length >= 8) return;
    const attrs = m[1];
    const src = attrs.match(/src=["']([^"']+)["']/i)?.[1];
    const alt = attrs.match(/alt=["']([^"']*)["']/i)?.[1] || '';
    const w   = parseInt(attrs.match(/width=["']?(\d+)/i)?.[1]  || '0');
    const h   = parseInt(attrs.match(/height=["']?(\d+)/i)?.[1] || '0');
    if (!src) return;
    const resolved = resolveUrl(src);
    if (resolved && (w >= 200 || h >= 150 || alt.length >= 5) && !skipImg.test(resolved)) addImage(resolved, alt);
  });

  // ── 4. METADATA + WEBSITE SUMMARY ────────────────────────────────────────────
  const tagline = scraped.metaDesc?.slice(0, 200) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,})["']/i)?.[1]?.slice(0, 200) || null;

  const siteName    = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1];
  const titleTag    = scraped.title?.split(/[|\-\u2013\u2014]/)[0]?.trim();
  const companyName = siteName || titleTag || job.prospect_company || null;

  // website_summary: first 600 chars of Jina-rendered text — shown in Source Intelligence panel
  const websiteSummary = bodyText.slice(0, 600) || null;

  // ── 5. FONT FAMILY: 3-path waterfall (CSS variables → body declaration → Google Fonts link) ──
  // Captured as a comma-separated value safe to drop into a `font-family:` declaration.
  const cleanFontValue = (raw) => {
    if (!raw) return null;
    let v = raw.trim().replace(/[;{}]/g, '').replace(/\s+/g, ' ').trim();
    if (v.length > 120) v = v.slice(0, 120);
    return v.length >= 3 ? v : null;
  };
  let fontFamily = null;

  // Path 1: CSS variables in inline <style> blocks or external CSS we already fetched
  const fontVarPattern = /--(?:font-primary|font-family|font-heading|font-body|brand-font|font-sans|font-display|font-base)\s*:\s*([^;\n}]+)/i;
  const fontVarMatch = styleBlocks.match(fontVarPattern);
  if (fontVarMatch?.[1]) fontFamily = cleanFontValue(fontVarMatch[1]);

  // Path 2: body / html { font-family: ... } declaration
  if (!fontFamily) {
    const bodyFontMatch = styleBlocks.match(/(?:^|[\s,{])(?:body|html|:root)[^{]*\{[^}]*font-family\s*:\s*([^;}]+)/i);
    if (bodyFontMatch?.[1]) fontFamily = cleanFontValue(bodyFontMatch[1]);
  }

  // Path 3: Google Fonts <link> — pull the family name from the URL
  if (!fontFamily) {
    const gfontMatch = html.match(/<link[^>]+href=["']https?:\/\/fonts\.googleapis\.com\/css2?\?[^"']*family=([^&"':]+)/i);
    if (gfontMatch?.[1]) {
      const family = decodeURIComponent(gfontMatch[1]).replace(/\+/g, ' ').split(/[:,]/)[0].trim();
      if (family) fontFamily = cleanFontValue(`'${family}', sans-serif`);
    }
  }

  const brandData = {
    scraped:          true,
    source:           'html',
    domain:           domain,           // raw domain scraped (e.g. xeleratio.com)
    company_name:     companyName,
    tagline:          tagline?.trim() || null,
    website_summary:  websiteSummary,
    logo_url:         logoUrl,
    favicon_url:      faviconUrl,
    primary_color:    primaryColor,
    secondary_color:  secondaryColor,
    accent_color:     accentColor,
    all_colors:       [...new Set(allColors)].filter(isValidColor).slice(0, 6),
    font_family:      fontFamily,
    images:           images.slice(0, 8),
  };

  await updateJobBrandData(job.id, brandData);
  console.log(`[brand_scrape] Done: logo=${!!logoUrl}, color=${primaryColor||'none'}, font=${fontFamily||'none'}, images=${images.length}, summary=${websiteSummary?.length||0}chars`);
  return brandData;
}

async function handleLeadList(task, job) {
  // Brief is stored in extracted_data — confirmed by rep before job was created
  const brief = job.extracted_data || {};
  const icp   = brief.icp || {};

  // Pass the full ICP — do NOT reconstruct a subset. apollo_geography, apollo_employee_ranges,
  // apollo_keyword, person_seniorities are all needed by fetchLeadsFromApollo.
  console.log('[lead_list] ICP from brief:', JSON.stringify(icp));

  // ── B2C short-circuit ─────────────────────────────────────────────────────
  // Apollo is a B2B contact database. If the prospect's target audience is consumers
  // (homeowners, residents, end-users), no amount of filter relaxation produces leads.
  // Detect via explicit flag from extractor, OR via heuristic on titles.
  const B2C_TITLE_TOKENS = /\b(homeowner|home\s?owner|resident|tenant|consumer|customer|end[-\s]?user|buyer|individual|prospect)\b/i;
  const titleLooksB2C = Array.isArray(icp.apollo_titles) &&
    icp.apollo_titles.length > 0 &&
    icp.apollo_titles.every(t => B2C_TITLE_TOKENS.test(String(t || '')));
  const isB2C = icp.target_audience_type === 'b2c' || titleLooksB2C;
  if (isB2C) {
    const msg = 'Target audience is consumers (B2C). Apollo is a B2B contact database — manual list or alternate data source needed.';
    console.warn('[lead_list] B2C target detected — routing to needs_input:', msg);
    if (task?.id) await needsInputTask(task.id, msg);
    return null; // signal needs_input — worker will not mark completed
  }

  const result = await fetchLeadsFromApollo(icp);
  const rawLeads = result?.leads || [];

  // Build the apollo_id → enriched_lead cache from previous jobs for this same
  // prospect_email. Cache hits skip the people/match Apollo call (1 credit
  // each). Brand-new prospects produce an empty cache → identical behavior to
  // before this change.
  const enrichmentCache = await getCachedApolloEnrichments(job.prospect_email, job.id);
  if (enrichmentCache.size) {
    console.log(`[lead_list] Apollo enrichment cache: ${enrichmentCache.size} leads from prior jobs for ${job.prospect_email}`);
  }
  // Dedup + size fallback + people-match — shared finalizer so handleLeadList
  // (worker) and rerun-apollo produce identical output. People-match runs for
  // every lead with an apollo_id at this step, so reps see real names + emails
  // immediately instead of obfuscated stubs (~25 enrichment credits per job,
  // minus any cache hits from previous jobs for the same prospect).
  const { leads, sizeFallback } = await finalizeLeadList(rawLeads, icp, enrichmentCache);
  console.log(`[lead_list] Dedup: ${rawLeads.length} → ${leads.length} unique-company leads (size fallback: ${sizeFallback || 'none'})`);

  // fetchLeadsFromApollo returns { total }; legacy callers used { totalAvailable }
  const tam    = result?.total ?? result?.totalAvailable ?? 0;
  // Lloyd's rep-proof outreach formula:
  // TAM > 300K → cap at 100K/mo (QS practical maximum)
  // TAM ≤ 300K → exhaust market in exactly 3 months
  const recommendedOutreach = tam > 300000
    ? 100000
    : tam > 0 ? Math.max(1000, Math.round(tam / 3 / 1000) * 1000) : 30000;
  console.log(`[lead_list] Apollo returned ${leads.length} classified leads, TAM: ${tam}, Outreach: ${recommendedOutreach}/mo`);
  // Phase 4: fire apollo_warning notification if fewer than 5 leads
  if (leads.length < 5) {
    await createNotification({
      type:  'apollo_warning',
      title: `Low leads: only ${leads.length} found`,
      body:  `Apollo returned fewer than 5 leads. Consider broadening the ICP filters.`,
      jobId: task?.job_id || null
    });
  }
  return {
    leads,
    total: tam,
    adjacent_total: result?.adjacent_total ?? null,    // industry-keyword-stripped TAM, surfaced in the UI as "Adjacent"
    recommendedOutreach,
    tamSource: 'apollo_api_live',
    apollo_diagnostics: {
      wasRelaxed: result?.wasRelaxed || false,
      relaxationLog: result?.relaxationLog || [],
      finalPayload: result?.finalPayload || {},
      adjacent_total: result?.adjacent_total ?? null
    }
  };
}

async function handleWebinarTitles(task, job) {
  const extracted = job.extracted_data;
  if (!extracted) throw new Error('webinar_titles: extracted_data missing');
  const company = extracted.prospect?.company || job.prospect_company || job.prospect_website || 'Your Company';
  const result = await generateWebinarTitles(extracted, company, job);
  return result;
}

async function handleRoiModel(task, job) {
  const extracted = job.extracted_data;
  // Brief schema stores under metrics; spec schema uses business — support both
  const rawLtv = extracted?.metrics?.ltv || extracted?.business?.ltv;

  if (!rawLtv) {
    await needsInputTask(task.id, 'Missing: LTV — rep must enter manually');
    return null; // signal needs_input
  }
  const ltv = parseLtv(rawLtv);
  if (!ltv) {
    await needsInputTask(task.id, `Could not parse LTV from "${rawLtv}" — rep must enter manually`);
    return null;
  }

  const closeRate = parseRate(extracted?.metrics?.close_rate || extracted?.business?.close_rate, 0.20);
  const showRate  = parseRate(extracted?.metrics?.show_rate  || extracted?.business?.show_rate,  0.70);
  const projections = calcRoiProjections(ltv, closeRate, showRate);

  if (!ROI_MODEL_TEMPLATE) ROI_MODEL_TEMPLATE = ensureTemplate('roi_model.html');
  if (!ROI_MODEL_TEMPLATE) throw new Error('roi_model.html template not loaded');

  const company = extracted?.prospect?.company || job.prospect_company || 'Your Company';
  const htmlContent = interpolate(ROI_MODEL_TEMPLATE, {
    COMPANY_NAME:     company,
    LTV:              ltv,
    CLOSE_RATE:       Math.round(closeRate * 100),
    SHOW_RATE:        Math.round(showRate * 100),
    REVENUE_6MO:      projections.revenue_6mo.toLocaleString(),
    REVENUE_12MO:     projections.revenue_12mo.toLocaleString(),
    REVENUE_24MO:     projections.revenue_24mo.toLocaleString(),
    REV1_PER_WEBINAR: projections.rev1_per_webinar.toLocaleString(),
    REV2_PER_WEBINAR: projections.rev2_per_webinar.toLocaleString(),
    CLOSE_RATE_SOURCE: (extracted?.metrics?.close_rate || extracted?.business?.close_rate) ? 'extracted from transcript' : 'default (20%)',
    SHOW_RATE_SOURCE:  (extracted?.metrics?.show_rate  || extracted?.business?.show_rate)  ? 'extracted from transcript' : 'default (70%)'
  });

  const storagePath = `${job.id}/roi_model.html`;
  const publicUrl = await storageUpload(storagePath, htmlContent);
  console.log(`[roi_model] Uploaded: ${publicUrl}`);

  return {
    url: publicUrl,
    inputs_used: {
      ltv, close_rate: closeRate, show_rate: showRate,
      close_rate_source: (extracted?.metrics?.close_rate || extracted?.business?.close_rate) ? 'extracted' : 'default',
      show_rate_source:  (extracted?.metrics?.show_rate  || extracted?.business?.show_rate)  ? 'extracted' : 'default'
    },
    projections
  };
}

async function handleCalendarVisual(task, job) {
  // Fetch dependencies
  const webinarTitlesTask = await getTaskOutput(job.id, 'webinar_titles');
  if (!webinarTitlesTask || webinarTitlesTask.status !== 'completed') {
    throw new Error('DEPS_PENDING: calendar_visual waiting for webinar_titles');
  }
  // calendar_blockers is the most common drift wrapper-key the model returned before
  // the generator-side normalizer landed. Old jobs still have output_data shaped that
  // way; accept it here so they recover on next worker tick without a full rerun.
  const titles = webinarTitlesTask.output_data?.variants
              || webinarTitlesTask.output_data?.calendar_blockers
              || webinarTitlesTask.output_data?.titles
              || [];
  const recIdx = Number.isInteger(webinarTitlesTask.output_data?._recommended_index)
    ? webinarTitlesTask.output_data._recommended_index
    : 0;
  const variant = titles[recIdx] || titles[0];
  if (!variant) throw new Error('calendar_visual: no title variant found');

  const extracted = job.extracted_data || {};
  const hostName  = job.research_data?.host?.name || extracted.prospect?.name || job.prospect_company || 'Your Host';
  const hostBio   = job.research_data?.host?.bio  || `${hostName} helps businesses grow through proven webinar strategies.`;

  const prospectCompany = extracted.prospect?.company || job.prospect_company || '';

  // Generate reminder emails via AI prompt
  const emailsResult = await generateReminderEmails(
    variant.title, hostName,
    extracted.result_delivered || extracted.angle?.result,
    extracted.customer_pain   || extracted.angle?.pain,
    prospectCompany
  ).catch(e => { console.warn('[calendar_visual] email gen failed:', e.message); return null; });
  const emails = emailsResult?.emails || [];

  // Next Tuesday ~3 weeks from now
  const eventDate = new Date();
  eventDate.setDate(eventDate.getDate() + 21);
  while (eventDate.getDay() !== 2) eventDate.setDate(eventDate.getDate() + 1);
  const dateStr = eventDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + ' · 7:00 – 8:00pm';

  if (!CALENDAR_VISUAL_TEMPLATE) CALENDAR_VISUAL_TEMPLATE = ensureTemplate('calendar_visual.html');
  if (!CALENDAR_VISUAL_TEMPLATE) throw new Error('calendar_visual.html template not loaded');

  // Compose description from the 12-field variant in the same order as the
  // portal renderer (`buildGeneratedDesc` in mockup-portal.html): opener →
  // proof story → contrast frame → session promise → RSVP → bullets → reframe
  // → urgency close → P.S. → For: line. The legacy `variant.description ‖
  // variant.hook+bullets+for_line` fallback was deleted along with the old
  // 4-field schema — any variant reaching here must have the 12-field shape
  // (enforced by the per-variant guard in generateWebinarTitles).
  const bullets = Array.isArray(variant.bullets) ? variant.bullets : [];
  const description = [
    variant.conditional_opener,
    variant.proof_story,
    variant.contrast_frame,
    variant.session_promise,
    variant.rsvp_block,
    bullets.join('\n'),
    variant.reframe_line,
    variant.urgency_close,
    variant.ps_replay,
    variant.for_line ? `For: ${variant.for_line}` : null,
  ].filter(Boolean).join('\n\n');

  const htmlContent = interpolate(CALENDAR_VISUAL_TEMPLATE, {
    EVENT_TITLE:       (variant.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    EVENT_DATE:        dateStr,
    EVENT_DESCRIPTION: description.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'),
    HOST_NAME:         (hostName || '').replace(/</g, '&lt;'),
    HOST_BIO:          (hostBio  || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    EMAILS_JSON:       JSON.stringify(emails)
  });

  const storagePath = `${job.id}/calendar_visual.html`;
  const publicUrl   = await storageUpload(storagePath, htmlContent);
  console.log(`[calendar_visual] Uploaded: ${publicUrl}`);
  // Portal reads `emails` (for reminder copy) and `title`; everything else in
  // the calendar invite UI is rendered from webinar_titles directly. Legacy
  // `hook`/`bullets`/`for_line` keys removed with the 4-field schema cleanup.
  return {
    url:        publicUrl,
    title:      variant.title,
    host_name:  hostName,
    event_date: dateStr,
    emails:     emails,
  };
}

// ── Stage orchestration — spawn new tasks when dependencies are met ───────────
async function checkAndSpawnStageTasks(jobId) {
  const tasks = await getTasksByJobId(jobId);
  const byType = {};
  tasks.forEach(t => { byType[t.task_type] = t; });

  const isTerminal = s => ['completed', 'failed', 'needs_input'].includes(s);

  // Stage 2: spawn when extract is completed
  const extractDone = byType['extract']?.status === 'completed';
  if (extractDone) {
    const stage2Types = ['brand_scrape', 'lead_list', 'webinar_titles', 'roi_model'];
    const toCreate = stage2Types.filter(t => !byType[t]);
    if (toCreate.length) {
      console.log(`[orchestrator] Spawning Stage 2 tasks: ${toCreate.join(', ')}`);
      await createTasks(jobId, toCreate);
    }
  }

  // Stage 3: spawn when brand_scrape is terminal AND webinar_titles completed AND prospect_research terminal
  const brandScrapeTerminal = byType['brand_scrape'] && isTerminal(byType['brand_scrape'].status);
  const webinarTitlesDone   = byType['webinar_titles']?.status === 'completed';
  const prospectResearchTerminal = !byType['prospect_research'] || isTerminal(byType['prospect_research'].status);

  if (brandScrapeTerminal && webinarTitlesDone && prospectResearchTerminal) {
    const stage3Types = ['calendar_visual'];
    const toCreate = stage3Types.filter(t => !byType[t]);
    if (toCreate.length) {
      console.log(`[orchestrator] Spawning Stage 3 tasks: ${toCreate.join(', ')}`);
      await createTasks(jobId, toCreate);
    }
  }

  // Update job status: completed when all created tasks are terminal
  const allTasks = await getTasksByJobId(jobId);
  if (allTasks.length > 0 && allTasks.every(t => isTerminal(t.status))) {
    const anyFailed = allTasks.some(t => t.status === 'failed');
    const finalStatus = anyFailed ? 'failed' : 'completed';
    await updateJobStatus(jobId, finalStatus);
    // Phase 4: fire job_complete notification
    if (finalStatus === 'completed') {
      const jobRow = await supabaseRequest('GET', `/rest/v1/jobs?id=eq.${jobId}&select=prospect_email,prospect_company,rep_name`);
      const j = (jobRow.body || [])[0] || {};
      const label = j.prospect_company || j.prospect_email || jobId;
      await createNotification({
        type:  'job_complete',
        title: `Analysis complete: ${label}`,
        body:  `Deal Forge job finished for ${j.prospect_email || 'unknown'}`,
        jobId: jobId,
        repId: j.rep_name || null
      });
    }
  }
}

// ── Worker loop ───────────────────────────────────────────────────────────────
let workerBusy = false;

async function processNextTask() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const pending = await getPendingTasks(1);
    if (!pending.length) return;

    const task = pending[0];
    const claimed = await claimTask(task.id);
    if (!claimed) return; // another worker claimed it (shouldn't happen on single-server but safe)

    const job = await getJob(task.job_id);
    if (!job) { await retryOrFailTask(task, 'Parent job not found'); return; }

    console.log(`[worker] Running ${task.task_type} (task ${task.id}) for job ${task.job_id}`);

    try {
      let output = null;
      let assetUrl = null;

      switch (task.task_type) {
        case 'extract':           output = await handleExtract(task, job);           break;
        case 'prospect_research': output = await handleProspectResearch(task, job);  break;
        case 'brand_scrape':      output = await handleBrandScrape(task, job);       break;
        case 'lead_list':         output = await handleLeadList(task, job);          break;
        case 'webinar_titles':    output = await handleWebinarTitles(task, job);     break;
        case 'roi_model':         output = await handleRoiModel(task, job);          break;
        case 'calendar_visual':   output = await handleCalendarVisual(task, job);    break;
        default: throw new Error(`Unknown task type: ${task.task_type}`);
      }

      // null output = handler set its own status (needs_input) — don't override
      if (output !== null) {
        if (output?.url) assetUrl = output.url;
        await completeTask(task.id, output, assetUrl);
        console.log(`[worker] ✓ ${task.task_type} completed`);
      }

    } catch(e) {
      console.error(`[worker] ✗ ${task.task_type} failed:`, e.message);
      // DEPS_PENDING = dependency not ready yet, reschedule in ~15s (not a real failure)
      if (e.message?.includes('not yet completed') || e.message?.includes('DEPS_PENDING')) {
        await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${task.id}`, {
          status: 'pending', started_at: null, updated_at: new Date().toISOString()
        });
        console.log(`[worker] ↻ ${task.task_type} rescheduled (deps not ready)`);
      } else {
        // Retry up to max_attempts, then fail permanently
        await retryOrFailTask(task, e.message);
      }
    }

    // Always check if new stage tasks should be spawned
    await checkAndSpawnStageTasks(task.job_id);

  } catch(e) {
    console.error('[worker] Uncaught error:', e.message);
  } finally {
    workerBusy = false;
  }
}

// ── Recovery cron — reset stuck processing tasks (>10 min) ───────────────────
async function resetStuckTasks() {
  try {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const r = await supabaseRequest('PATCH',
      `/rest/v1/tasks?status=eq.processing&started_at=lt.${cutoff}`,
      { status: 'pending', started_at: null, updated_at: new Date().toISOString() },
      { 'Prefer': 'return=minimal' }
    );
    if (r.status < 400) console.log('[recovery] Reset stuck tasks (if any)');
  } catch(e) { console.warn('[recovery] Failed:', e.message); }
}

// ── PHASE 2: Call Library sync ─────────────────────────────────────────────────
// Pulls the most recent 100 Fireflies transcripts, computes a Q-Score (0-100)
// based on structural signals (no Claude call — fast + free), classifies call type,
// then upserts into the Supabase `calls` table.
// Rules for Q-Score:
//   +25  has shorthand_bullet notes (action items / detailed notes)
//   +20  has overview (metrics overview summary)
//   +15  has short_summary
//   +10  duration >= 20 min  (longer = more context)
//   +10  has >= 1 attendee with email
//   +5   title contains known call keywords (discovery, strategy, BEC, evaluation)
//   +5   has action_items
//   Deductions:
//   -20  duration < 5 min (likely accidental recording)
//   -10  title contains admin/internal keywords (standup, sync, team)
// Score range: 0–100 (clamped)
// Call type classification rules:
//   'bec'       — title matches: discovery, evaluation, bec, strategy session, call 1, consultation
//   'follow_up' — title matches: follow.?up, call 2, call 3, debrief, check.?in, proposal
//   'admin'     — title matches: standup, team, sync, internal, interview, 1.?on.?1
//   'unclassified' — default fallback
function classifyCallType(title = '') {
  const t = title.toLowerCase();
  if (/discovery|evaluation|bec|strategy session|call[\s_-]?1\b|consultation|intro call|intake/i.test(t)) return 'bec';
  if (/follow[\s-]?up|call[\s_-]?[23456]|debrief|check[\s-]?in|proposal|closing|pitch/i.test(t)) return 'follow_up';
  if (/standup|stand-up|team|internal|interview|1[\s-]on[\s-]1|onboard|training/i.test(t)) return 'admin';
  return 'unclassified';
}

function computeQScore(transcript) {
  let score = 0;
  const reasons = [];
  const s = transcript.summary || {};
  const dur = transcript.duration || 0;
  const title = (transcript.title || '').toLowerCase();
  const attendees = (transcript.meeting_attendees || []).filter(a => a.email);

  if (s.shorthand_bullet && s.shorthand_bullet.trim().length > 50) { score += 25; reasons.push('has detailed notes'); }
  if (s.overview         && s.overview.trim().length > 30)          { score += 20; reasons.push('has metrics overview'); }
  if (s.short_summary    && s.short_summary.trim().length > 30)     { score += 15; reasons.push('has summary'); }
  if (s.action_items     && s.action_items.trim().length > 10)      { score +=  5; reasons.push('has action items'); }
  if (dur >= 20)  { score += 10; reasons.push(`long call (${dur.toFixed(0)} min)`); }
  if (attendees.length >= 1) { score += 10; reasons.push(`${attendees.length} attendee email(s)`); }
  if (/discovery|evaluation|bec|strategy|consultation/i.test(title)) { score += 5; reasons.push('BEC/strategy keyword in title'); }

  // Deductions
  if (dur > 0 && dur < 5) { score -= 20; reasons.push('very short call (<5 min)'); }
  if (/standup|internal|team sync|interview/i.test(title)) { score -= 10; reasons.push('admin/internal call'); }

  return { q_score: Math.max(0, Math.min(100, score)), q_reasons: reasons };
}

async function syncFirefliesToCallLibrary() {
  console.log('[CallLib] Starting Fireflies sync...');
  const FULL_FIELDS = `id title duration date meeting_attendees { name email }
    summary { shorthand_bullet overview short_summary action_items }`;
  let allTranscripts = [];
  try {
    const d1 = await firefliesQuery(`{ transcripts(limit: 50) { ${FULL_FIELDS} } }`, {});
    allTranscripts.push(...(d1?.transcripts || []));
    const d2 = await firefliesQuery(`{ transcripts(limit: 50, skip: 50) { ${FULL_FIELDS} } }`, {});
    allTranscripts.push(...(d2?.transcripts || []));
  } catch(e) {
    console.error('[CallLib] Fireflies fetch error:', e.message);
    return [];
  }
  console.log(`[CallLib] Fetched ${allTranscripts.length} transcripts from Fireflies`);

  const upserted = [];
  for (const t of allTranscripts) {
    if (!t.id) continue;
    const { q_score, q_reasons } = computeQScore(t);
    const call_type = classifyCallType(t.title);
    // default status: admin → skipped, BEC/follow_up with q >= 50 → pending_review, else → pending_review
    const status = call_type === 'admin' && q_score < 30 ? 'skipped' : 'pending_review';

    const row = {
      id:           t.id,
      title:        t.title || '(untitled)',
      duration:     t.duration || null,
      date:         t.date ? new Date(t.date).toISOString() : null,
      attendees:    JSON.stringify(t.meeting_attendees || []),
      summary:      JSON.stringify(t.summary || {}),
      call_type,
      q_score,
      q_reasons:    JSON.stringify(q_reasons),
      status,
      synced_at:    new Date().toISOString(),
      raw_fireflies: JSON.stringify(t)
    };

    try {
      const r = await supabaseRequest('POST', '/rest/v1/calls', row,
        { 'Prefer': 'return=minimal,resolution=merge-duplicates', 'Content-Profile': 'public' });
      if (r.status < 300) { upserted.push({ id: t.id, title: t.title, call_type, q_score, status }); }
      else {
        if (upserted.length === 0) console.warn(`[CallLib] First upsert error body:`, JSON.stringify(r.body).slice(0,300));
        console.warn(`[CallLib] Upsert failed for ${t.id}: ${r.status}`);
      }
    } catch(e) { console.warn(`[CallLib] Upsert error for ${t.id}:`, e.message); }
  }
  console.log(`[CallLib] Sync complete: ${upserted.length}/${allTranscripts.length} upserted`);

  // Phase 4: fire in-app notifications for newly upserted BEC calls
  const newBecs = upserted.filter(u => u.call_type === 'bec');
  for (const bec of newBecs.slice(0, 5)) { // cap at 5 per sync to avoid flood
    await createNotification({
      type:   'new_bec',
      title:  `New BEC: ${bec.title}`,
      body:   `Q-Score: ${bec.q_score} · Status: ${bec.status}`,
      callId: bec.id
    });
  }
  if (newBecs.length > 0) console.log(`[CallLib] Fired ${Math.min(newBecs.length,5)} new_bec notifications`);

  return upserted;
}

// Start worker + recovery loops
if (USE_SUPABASE) {
  // Wrap each invocation in .catch() so a network error (ECONNRESET, ETIMEDOUT)
  // in one task cycle doesn't propagate to the top-level interval and silently
  // stop the worker. The outer try/catch in processNextTask already handles most
  // cases, but an unhandled rejection from an async timer edge-case can bypass it.
  setInterval(() => processNextTask().catch(e => console.error('[worker] Interval error:', e.message)), 3000);
  setInterval(() => resetStuckTasks().catch(e => console.error('[recovery] Interval error:', e.message)), 2 * 60 * 1000);
  // Phase 2: 6-hour background Fireflies sync safety net
  setInterval(() => syncFirefliesToCallLibrary().catch(e => console.error('[CallLib] Cron error:', e.message)), 6 * 60 * 60 * 1000);
  console.log('[worker] Started (3s interval)');
  console.log('[recovery] Started (2min interval)');
  console.log('[CallLib] 6-hour background sync scheduled');
} else {
  console.warn('[worker] NOT started — no Supabase config');
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    setCors(res); res.writeHead(204); res.end(); return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 2 — CALL LIBRARY API
  // ══════════════════════════════════════════════════════════════════════════

  // ── POST /api/calls/sync — pull recent Fireflies transcripts into `calls` table ──
  // Called manually from the Call Library tab, and by the 6-hour background cron.
  if (req.method === 'POST' && urlPath === '/api/calls/sync') {
    setCors(res);
    try {
      const synced = await syncFirefliesToCallLibrary();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ synced: synced.length, calls: synced }));
    } catch(e) {
      console.error('[POST /api/calls/sync]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/calls — list all calls with optional filters ────────────────
  if (req.method === 'GET' && urlPath === '/api/calls') {
    setCors(res);
    try {
      const qs     = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
      const status = qs.get('status') || '';
      const type   = qs.get('type') || '';
      const limit  = Math.min(parseInt(qs.get('limit') || '100', 10), 200);

      let query = `/rest/v1/calls?order=date.desc&limit=${limit}`;
      if (status) query += `&status=eq.${encodeURIComponent(status)}`;
      if (type)   query += `&call_type=eq.${encodeURIComponent(type)}`;

      const r = await supabaseRequest('GET', query, null, { 'Accept-Profile': 'public' });
      const calls = (r.status === 200 && Array.isArray(r.body)) ? r.body : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(calls));
    } catch(e) {
      console.error('[GET /api/calls]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PATCH /api/calls/:id/status — rep manually overrides status ──────────
  if (req.method === 'PATCH' && urlPath.match(/^\/api\/calls\/[^/]+\/status$/)) {
    setCors(res);
    const callId = urlPath.split('/')[3];
    try {
      const body      = await parseBody(req);
      const newStatus = body.status; // approved|skipped|pending_review
      const VALID = new Set(['approved','skipped','pending_review']);
      if (!VALID.has(newStatus)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid status. Must be: ${[...VALID].join('|')}` }));
        return;
      }
      const r = await supabaseRequest('PATCH', `/rest/v1/calls?id=eq.${callId}`,
        { status: newStatus }, { 'Prefer': 'return=representation', 'Content-Profile': 'public' });
      if (r.status >= 400) throw new Error(`Supabase PATCH calls: ${r.status}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ updated: true, status: newStatus }));
    } catch(e) {
      console.error('[PATCH /api/calls/:id/status]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Phase 4: GET /api/notifications — list recent notifications ─────────────
  if (req.method === 'GET' && urlPath === '/api/notifications') {
    setCors(res);
    try {
      const qs    = new URLSearchParams(req.url.split('?')[1] || '');
      const limit = parseInt(qs.get('limit') || '50', 10);
      const unreadOnly = qs.get('unread') === '1';
      let query = `/rest/v1/notifications?order=created_at.desc&limit=${limit}`;
      if (unreadOnly) query += '&read=eq.false';
      const r = await supabaseRequest('GET', query, null, { 'Accept-Profile': 'public' });
      const rows = (r.status === 200 && Array.isArray(r.body)) ? r.body : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Phase 4: PATCH /api/notifications/read-all — mark all read ──────────────
  if (req.method === 'PATCH' && urlPath === '/api/notifications/read-all') {
    setCors(res);
    try {
      await supabaseRequest('PATCH', '/rest/v1/notifications?read=eq.false',
        { read: true }, { 'Prefer': 'return=minimal', 'Content-Profile': 'public' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Phase 4: PATCH /api/notifications/:id/read — mark one read ──────────────
  if (req.method === 'PATCH' && urlPath.match(/^\/api\/notifications\/[^/]+\/read$/)) {
    setCors(res);
    const notifId = urlPath.split('/')[3];
    try {
      await supabaseRequest('PATCH', `/rest/v1/notifications?id=eq.${notifId}`,
        { read: true }, { 'Prefer': 'return=minimal', 'Content-Profile': 'public' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Phase 4: GET /api/prospect/:email — Prospect Intelligence File data ──────
  if (req.method === 'GET' && urlPath.match(/^\/api\/prospect\/.+/)) {
    setCors(res);
    const email = decodeURIComponent(urlPath.split('/api/prospect/')[1] || '').toLowerCase();
    if (!email || !email.includes('@')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Valid email required' })); return;
    }
    try {
      // Parallel: fetch calls and jobs for this email
      const [callsR, jobsR, fileR] = await Promise.all([
        supabaseRequest('GET',
          `/rest/v1/calls?order=date.desc&limit=20`,
          null, { 'Accept-Profile': 'public' }),
        supabaseRequest('GET',
          `/rest/v1/jobs?prospect_email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=10`),
        supabaseRequest('GET',
          `/rest/v1/prospect_files?email=eq.${encodeURIComponent(email)}&limit=1`,
          null, { 'Accept-Profile': 'public' })
      ]);

      // Filter calls by attendee email client-side
      const emailLower = email.toLowerCase();
      const allCalls = (callsR.status === 200 && Array.isArray(callsR.body)) ? callsR.body : [];
      const matchedCalls = allCalls.filter(c => {
        let att = c.attendees || [];
        if (typeof att === 'string') { try { att = JSON.parse(att); } catch(e) { att = []; } }
        return att.some(a => (a.email || '').toLowerCase() === emailLower);
      });

      const jobs = (jobsR.status === 200 && Array.isArray(jobsR.body)) ? jobsR.body : [];
      const file = (fileR.status === 200 && Array.isArray(fileR.body) && fileR.body[0]) ? fileR.body[0] : null;

      // Add portal_url to each job (format matches dashboard: /?job=ID)
      const jobsWithPortal = jobs.map(j => ({
        ...j,
        portal_url: j.portal_url || `/?job=${j.id}`
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email, calls: matchedCalls, jobs: jobsWithPortal, file }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/prefetch — async phase-1 lookup (GHL + Fireflies + scrape) ───
  // Returns 202 + { prefetch_id } immediately; client polls GET /api/prefetch/:id.
  // Phase 1 produces the candidate Fireflies transcripts so the rep can pick the
  // right one before any Claude tokens are burned. Brief extraction is phase 2
  // (POST /api/extract-brief) and only runs after the rep confirms a candidate.
  if (req.method === 'POST' && urlPath === '/api/prefetch') {
    setCors(res);
    try {
      const body  = await parseBody(req);
      const email = (body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid email required' })); return;
      }
      const id = newProgressJob('prefetch');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prefetch_id: id }));

      // Run phase-1 in the background. Errors land on the progress map; the
      // client surfaces them in the New Job UI.
      (async () => {
        try {
          setProgress(id, { progress: 10, step: 'Looking up GHL contact…' });
          // Every new job starts fresh — no historical brief / company / website
          // reuse from prior jobs for this same prospect. Reps explicitly asked
          // for this so that re-runs after a fresh Fireflies call don't inherit
          // stale extracted fields from an older job.
          const ghlContact = await lookupGHLContact(email);

          setProgress(id, { progress: 25, step: 'Resolving sales rep…' });
          // Precedence: opportunity owner > contact owner. Reps work the deal,
          // not the contact, so the opp's assignedTo is the authoritative rep.
          // Contact owner is just a fallback for prospects with no opportunity yet.
          let repSource  = null;
          let repUserId  = null;
          let repOppMeta = null;
          if (ghlContact?.id) {
            const oppOwner = await lookupGHLOpportunityOwner(ghlContact.id);
            if (oppOwner?.ghl_user_id) {
              repUserId  = oppOwner.ghl_user_id;
              repSource  = 'ghl_opportunity';
              repOppMeta = { id: oppOwner.opportunity_id, name: oppOwner.opportunity_name };
            }
          }
          if (!repUserId && ghlContact?.ghl_user_id) {
            repUserId = ghlContact.ghl_user_id;
            repSource = 'ghl_contact';
          }
          const repRow = await getRepByGhlUserId(repUserId);
          const rep = repRow
            ? { slug: repRow.slug, display_name: repRow.display_name, source: repSource, opportunity: repOppMeta }
            : null;

          const emailDomain = email.split('@')[1] || '';
          const contactSources = {};
          const pick = (field, ...candidates) => {
            for (const [src, val] of candidates) {
              if (val != null && val !== '') { contactSources[field] = src; return val; }
            }
            contactSources[field] = null;
            return null;
          };
          // Filter free-mail domains out of every website source. GHL records
          // occasionally store `website=outlook.com` when the email domain was
          // auto-synced — that propagates a bogus suggestion to the rep. We
          // never want to scrape outlook.com / gmail.com / yahoo.com.
          const contactInfo = {
            name:         pick('name',
                              ['rep_input', body.name],
                              ['ghl',       ghlContact?.name]),
            company:      pick('company',
                              ['rep_input', body.company],
                              ['ghl',       ghlContact?.company]),
            title:        pick('title',
                              ['ghl',       ghlContact?.title]),
            website:      pick('website',
                              ['rep_input',    cleanWebsiteCandidate(body.website)],
                              ['ghl',          cleanWebsiteCandidate(ghlContact?.website)],
                              ['email_domain', cleanWebsiteCandidate(emailDomain)]),
            linkedin_url: pick('linkedin_url',
                              ['rep_input', body.linkedin_url],
                              ['ghl',       ghlContact?.linkedin_url])
          };
          if (contactInfo.website) {
            contactInfo.website = String(contactInfo.website).replace(/^https?:\/\//, '').split('/')[0];
          }

          // Apollo people/match fills LinkedIn / name / company / title when GHL is sparse.
          const needsApollo = !contactInfo.linkedin_url || !contactInfo.name || !contactInfo.company || !contactInfo.title;
          if (needsApollo && !isFreeMailDomain(emailDomain)) {
            setProgress(id, { progress: 35, step: 'Apollo people/match…' });
            const apolloMatch = await apolloMatchByEmail(email);
            if (apolloMatch) {
              if (!contactInfo.linkedin_url && apolloMatch.linkedin_url) { contactInfo.linkedin_url = apolloMatch.linkedin_url; contactSources.linkedin_url = 'apollo'; }
              if (!contactInfo.name         && apolloMatch.name)         { contactInfo.name         = apolloMatch.name;         contactSources.name         = 'apollo'; }
              if (!contactInfo.company      && apolloMatch.company)      { contactInfo.company      = apolloMatch.company;      contactSources.company      = 'apollo'; }
              if (!contactInfo.title        && apolloMatch.title)        { contactInfo.title        = apolloMatch.title;        contactSources.title        = 'apollo'; }
              console.log(`[prefetch ${id.slice(0,8)}] Apollo: linkedin=${!!apolloMatch.linkedin_url}, name=${!!apolloMatch.name}, company=${!!apolloMatch.company}, title=${!!apolloMatch.title}`);
            }
          }

          // Approved-calls badge count
          const dbApproved = await findApprovedCallsFromDB(email);
          const approvedCallCount = dbApproved.length;

          // Phase 1 only does Fireflies search. The website scrape moves to
          // extract-brief so the rep can confirm/edit the URL first — no point
          // burning a fetch + JS render if they're going to change it.
          setProgress(id, { progress: 60, step: 'Searching Fireflies (parallel)…' });
          const candidates = await findFirefliesTranscripts(email, contactInfo);

          // Public candidate list — strip the heavy `sentences` blob and the
          // internal `_match_kind` tag, surfacing match_kind as a clean field.
          const publicCandidates = (candidates || []).slice(0, 10).map(t => ({
            id:         t.id,
            title:      t.title || null,
            duration:   t.duration || 0,
            date:       t.date || null,
            attendees:  (t.meeting_attendees || []).map(a => ({ email: a.email || null, name: a.displayName || null })),
            match_kind: t._match_kind || 'loose'
          }));

          setProgress(id, {
            progress: 100, status: 'completed', step: 'Done',
            result: {
              contact:                 contactInfo,
              contact_sources:         contactSources,
              rep:                     rep,
              approved_call_count:     approvedCallCount,
              candidates:              publicCandidates,
              suggested_candidate_id:  publicCandidates[0]?.id || null
            }
          });

          // Side-cache for phase 2 — extract-brief needs the raw candidate map
          // (for sentences). webBody is filled by extract-brief itself once the
          // rep has confirmed the URL.
          _progressJobs.get(id)._extras = {
            email,
            contactInfo,
            contactSources,
            candidatesById:  new Map((candidates || []).map(t => [t.id, t]))
          };
        } catch (e) {
          console.error(`[prefetch ${id.slice(0,8)}] failed:`, e.message);
          setProgress(id, { progress: 100, status: 'failed', step: 'Failed', error: e.message });
        }
      })();
    } catch(e) {
      console.error('[POST /api/prefetch]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/prefetch/:id — poll prefetch progress + result ────────────────
  if (req.method === 'GET' && urlPath.startsWith('/api/prefetch/')) {
    setCors(res);
    const id = urlPath.slice('/api/prefetch/'.length);
    const job = getProgress(id);
    if (!job || job.kind !== 'prefetch') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown prefetch_id (expired or never existed)' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:   job.status,
      progress: job.progress,
      step:     job.step,
      result:   job.result || null,
      error:    job.error  || null
    }));
    return;
  }

  // ── POST /api/extract-brief — async phase-2 Claude extraction ──────────────
  // Body: { prefetch_id, transcript_id }
  // transcript_id === null means the rep clicked "Skip — no transcript", in
  // which case we build an empty brief from the contact + website only.
  if (req.method === 'POST' && urlPath === '/api/extract-brief') {
    setCors(res);
    try {
      const body = await parseBody(req);
      const prefetchId  = (body.prefetch_id || '').trim();
      const transcriptId = body.transcript_id ? String(body.transcript_id) : null;
      const prefetchJob = getProgress(prefetchId);
      if (!prefetchJob || prefetchJob.kind !== 'prefetch' || prefetchJob.status !== 'completed') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Prefetch result not available — re-run search' }));
        return;
      }
      const extras = prefetchJob._extras;
      if (!extras) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Prefetch extras missing — re-run search' }));
        return;
      }
      const id = newProgressJob('extract_brief');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ extract_id: id }));

      // Rep-confirmed website (Step 1 input). Falls back to whatever phase 1
      // proposed if the input is empty. Stripped to host segment, no protocol.
      const confirmedWebsite = (function() {
        const raw = (body.website_url || body.websiteUrl || '').trim();
        const src = raw || extras.contactInfo.website || '';
        return src.replace(/^https?:\/\//, '').split('/')[0] || '';
      })();

      (async () => {
        try {
          const contactInfo    = { ...extras.contactInfo };
          const contactSources = { ...extras.contactSources };
          if (confirmedWebsite && confirmedWebsite !== contactInfo.website) {
            contactInfo.website = confirmedWebsite;
            contactSources.website = 'rep_input';
          }
          let   brief           = null;
          let   transcriptFound = false;
          let   transcriptTitle = null;
          let   transcriptDate  = null;

          // Scrape the rep-confirmed website now (direct → corsproxy fallback,
          // see scrapeWebsite). Produces bodyText for Claude + raw HTML that
          // brand_scrape will mine for logo/colors/images later. Best-effort:
          // if scrape fails we still extract the brief from the transcript.
          let website = null;
          let webBody = '';
          if (confirmedWebsite) {
            setProgress(id, { progress: 10, step: 'Scraping website…' });
            try { website = await scrapeWebsite(confirmedWebsite); webBody = website?.bodyText || ''; }
            catch (e) { console.warn(`[extract-brief ${id.slice(0,8)}] scrape failed:`, e.message); }
            // Company-from-website-title fallback (moved here from prefetch so
            // it runs against the rep-confirmed URL, not the initial guess).
            if (!contactInfo.company && website?.title) {
              const fromTitle = companyFromWebsiteTitle(website.title);
              if (fromTitle) {
                contactInfo.company = fromTitle;
                contactSources.company = 'website_title';
                console.log(`[extract-brief ${id.slice(0,8)}] company from website title: "${fromTitle}"`);
              }
            }
          }

          if (transcriptId) {
            // Manual-paste path: when none of the auto-detected Fireflies
            // candidates is right, the rep pastes a Fireflies link. The ID
            // won't be in candidatesById, so resolve title/date by fetching
            // detail directly from Fireflies.
            let candidate       = extras.candidatesById.get(transcriptId);
            let preloadedDetail = null;
            if (!candidate) {
              console.log(`[extract-brief ${id.slice(0,8)}] manual transcript_id ${transcriptId} (not in picker) — fetching detail directly`);
              setProgress(id, { progress: 20, step: 'Loading pasted Fireflies transcript…' });
              preloadedDetail = await fetchTranscriptDetail(transcriptId);
              if (!preloadedDetail) throw new Error(`Fireflies transcript ${transcriptId} not found or not accessible — check the link and that you have access`);
              candidate = preloadedDetail;
            }
            transcriptTitle = candidate.title || null;
            transcriptDate  = candidate.date || null;

            setProgress(id, { progress: 20, step: 'Loading transcript detail…' });
            const detail = preloadedDetail || await fetchTranscriptDetail(transcriptId);
            const s = (detail?.summary || candidate.summary) || {};
            // Tag each transcript turn as [REP] (QS rep speaking) vs [PROSPECT]
            // (the buyer speaking) so the extractor can source prospect-side
            // fields (offer_description, angle.pain, angle.result, verbatim
            // quotes, ICP) ONLY from [PROSPECT] turns — otherwise the rep's
            // pitch contaminates the brief and the downstream webinar copy
            // ends up describing QS's offer instead of the prospect's.
            const sentencesRaw = ((detail || candidate).sentences || []);
            const attendees = (detail || candidate).meeting_attendees || [];
            const repEmails = await getRepEmails();
            const annotated = _annotateTranscript(sentencesRaw, attendees, repEmails);
            const rawSentences = annotated.text || sentencesRaw
              .filter(x => x.text && x.text.trim().length > 0)
              .map(x => `${x.speaker_name || 'Speaker'}: ${x.text.trim()}`)
              .join('\n');
            const summaryParts = [s.shorthand_bullet, s.overview, s.short_summary, s.action_items].filter(Boolean).join('\n\n');
            const labelLegend = annotated.labeled
              ? `SPEAKER LABELS — turns are tagged: [REP]=Quantum Scaling sales rep (the seller), [PROSPECT]=the buyer being pitched, [SPEAKER]=unknown role.\n` +
                `Rep emails matched: ${[...repEmails].slice(0, 4).join(', ') || '(none in env)'}; counts → rep:${annotated.counts.rep} prospect:${annotated.counts.prospect} unknown:${annotated.counts.unknown}.\n` +
                `STRICT RULE: extract prospect-side fields (offer_description, angle.*, verbatim.*, icp.*, situation.*) ONLY from [PROSPECT] turns. Treat [REP] turns as PITCH CONTEXT only — never use them as the source of what the prospect's business does, who its customers are, or what its results are. If a field can only be supported by [REP] turns, return null with _provenance "missing".\n\n`
              : '';
            const txContent = rawSentences
              ? `${labelLegend}VERBATIM TRANSCRIPT:\n${rawSentences.slice(0, 12000)}\n\nSUMMARY NOTES:\n${summaryParts.slice(0, 2000)}`
              : summaryParts.slice(0, 14000);

            setProgress(id, { progress: 50, step: 'Extracting brief with Claude…' });
            console.log(`[extract-brief ${id.slice(0,8)}] Claude context: ${txContent.length} chars (${rawSentences.length} verbatim, labeled=${annotated.labeled} rep:${annotated.counts.rep} prospect:${annotated.counts.prospect})`);
            brief = await extractBriefFromTranscript(txContent, webBody, contactInfo);
            transcriptFound = true;

            // Stamp external-source provenance + promote any new transcript values
            // back into the contactInfo summary (same logic as the legacy handler).
            if (brief && typeof brief === 'object') {
              brief._provenance = brief._provenance || {};
              const setProv = (key, source) => {
                const current = brief._provenance[key];
                if (!current || current === 'missing') brief._provenance[key] = source;
              };
              if (contactSources.company)      setProv('prospect.company',       contactSources.company === 'website_title' ? 'website' : contactSources.company);
              if (contactSources.name)         setProv('prospect.contact_name',  contactSources.name);
              if (contactSources.title)        setProv('prospect.contact_title', contactSources.title);
              if (contactSources.linkedin_url) setProv('prospect.linkedin_url',  contactSources.linkedin_url);
            }
            if (brief?.prospect?.company && contactSources.company !== 'rep_input') {
              contactInfo.company = brief.prospect.company;
              contactSources.company = 'transcript';
              if (brief._provenance) brief._provenance['prospect.company'] = 'transcript';
            }
            if (brief?.prospect?.contact_name && contactSources.name !== 'rep_input') {
              contactInfo.name = brief.prospect.contact_name;
              contactSources.name = 'transcript';
              if (brief._provenance) brief._provenance['prospect.contact_name'] = 'transcript';
            }
            if (brief?.prospect?.contact_title) {
              contactInfo.title = brief.prospect.contact_title;
              contactSources.title = 'transcript';
            }
            // Promote a transcript-extracted website over weak Step-1 sources.
            // We trust the rep's typed URL above everything; otherwise transcript
            // beats GHL / history / email_domain / website_title (those can be
            // stale or wrong, but a URL the prospect spoke on the call won't be).
            const briefWebsite = (brief?.prospect?.website || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
            const cleanBriefWebsite = cleanWebsiteCandidate(briefWebsite);
            if (cleanBriefWebsite && contactSources.website !== 'rep_input') {
              contactInfo.website = cleanBriefWebsite;
              contactSources.website = 'transcript';
              if (brief._provenance) brief._provenance['prospect.website'] = 'transcript';
            }
          }

          setProgress(id, {
            progress: 100, status: 'completed', step: 'Done',
            result: {
              transcript_found:    transcriptFound,
              transcript_title:    transcriptTitle,
              transcript_date:     transcriptDate,
              transcript_id:       transcriptId,
              contact:             contactInfo,
              contact_sources:     contactSources,
              website_scrape:      website ? {
                title:       website.title || null,
                meta_desc:   website.metaDesc || null,
                bytes:       (website.html || '').length,
                html_source: website.html_source || 'none'
              } : null,
              brief:               brief || emptyBrief(contactInfo)
            }
          });
        } catch (e) {
          console.error(`[extract-brief ${id.slice(0,8)}] failed:`, e.message);
          setProgress(id, { progress: 100, status: 'failed', step: 'Failed', error: e.message });
        }
      })();
    } catch(e) {
      console.error('[POST /api/extract-brief]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/extract-brief/:id — poll extract-brief progress + result ──────
  if (req.method === 'GET' && urlPath.startsWith('/api/extract-brief/')) {
    setCors(res);
    const id = urlPath.slice('/api/extract-brief/'.length);
    const job = getProgress(id);
    if (!job || job.kind !== 'extract_brief') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown extract_id (expired or never existed)' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:   job.status,
      progress: job.progress,
      step:     job.step,
      result:   job.result || null,
      error:    job.error  || null
    }));
    return;
  }

  // ── POST /api/jobs — create job with confirmed brief, spawn full pipeline ──
  if (req.method === 'POST' && urlPath === '/api/jobs') {
    setCors(res);
    try {
      const body       = await parseBody(req);
      const email      = (body.email || '').trim().toLowerCase();
      const websiteUrl = (body.websiteUrl || '').trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
      const linkedinUrl = (body.linkedin_url || body.linkedinUrl || '').trim() || null;
      const transcriptId = (body.transcript_id || body.transcriptId || '').trim() || null;
      const brief      = body.brief || null;
      const repName    = (body.repName || body.rep_name || '').trim() || null; // B5 fix

      if (!email || !email.includes('@')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid email required' }));
        return;
      }

      // Stamp the chosen Fireflies transcript on the brief so we can tell later
      // whether the rep auto-accepted the top candidate or actively picked a
      // non-default one. Useful for tuning the search ranker without adding a
      // dedicated column.
      if (brief && typeof brief === 'object' && transcriptId) {
        brief._source = {
          ...(brief._source || {}),
          fireflies_transcript_id: transcriptId,
          picked_by:               body.transcript_picked_by || 'rep',
          picked_at:               new Date().toISOString()
        };
      }

      const job = await createJob(email, websiteUrl || null, brief, repName, linkedinUrl);
      // Spawn the full pipeline immediately:
      // - extract + prospect_research run now (re-extract with fresh transcript + LinkedIn)
      // - lead_list runs now (uses brief ICP which is already confirmed by rep)
      // - Stage 2 (brand_scrape, webinar_titles, roi_model) spawned by orchestrator when extract completes
      // - Stage 3 (calendar_visual) spawned when Stage 2 completes
      await createTasks(job.id, ['extract', 'prospect_research', 'lead_list']);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: job.id, portal_url: `/?job=${job.id}` }));
    } catch(e) {
      console.error('[POST /api/jobs]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/jobs — list recent jobs (dashboard) ─────────────────────────
  if (req.method === 'GET' && urlPath === '/api/jobs') {
    setCors(res);
    try {
      const r = await supabaseRequest('GET', '/rest/v1/jobs?order=created_at.desc&limit=100');
      console.log(`[GET /api/jobs] Supabase status=${r.status} rows=${Array.isArray(r.body) ? r.body.length : 'non-array'} USE_SUPABASE=${USE_SUPABASE}`);
      if (r.status >= 400) console.error('[GET /api/jobs] Supabase error body:', JSON.stringify(r.body));
      const jobs = (r.status === 200 && Array.isArray(r.body)) ? r.body : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jobs.map(j => ({
        job_id:          j.id,
        status:          j.status,
        prospect_email:  j.prospect_email,
        prospect_company: j.prospect_company,
        prospect_name:   j.prospect_name,
        assigned_rep:    j.rep_name || null,
        portal_url:      `/?job=${j.id}`,
        created_at:      j.created_at,
        updated_at:      j.updated_at
      }))));
    } catch(e) {
      console.error('[GET /api/jobs]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/jobs/:id — poll job status + task outputs ───────────────────
  // Tightened to match only `/api/jobs/{uuid}` exactly so later sub-routes like
  // `/api/jobs/{id}/assets/:asset` aren't shadowed by this broad startsWith.
  if (req.method === 'GET' && /^\/api\/jobs\/[^/]+$/.test(urlPath)) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length);
    try {
      const job = await getJob(jobId);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Job not found' }));
        return;
      }
      const tasks = await getTasksByJobId(jobId);
      const taskMap = {};
      tasks.forEach(t => { taskMap[t.task_type] = { status: t.status, output: t.output_data, asset_url: t.asset_url, error: t.error_message }; });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        job_id:                job.id,
        status:                job.status,
        prospect_email:        job.prospect_email,
        prospect_company:      job.prospect_company,
        prospect_name:         job.prospect_name,
        prospect_website:      job.prospect_website,
        prospect_linkedin_url: job.prospect_linkedin_url,
        extracted_data:        job.extracted_data,
        brand_data:            job.brand_data,
        research_data:         job.research_data,
        tasks:                 taskMap,
        created_at:            job.created_at,
        updated_at:            job.updated_at
      }));
    } catch(e) {
      console.error('[GET /api/jobs/:id]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PATCH /api/jobs/:id/prospect-info — rep edits prospect basics + full brief ──
  // Updates the top-level prospect columns AND optionally replaces the brief
  // (extracted_data) when `brief` is supplied. _meta and _overrides on the
  // existing extracted_data are preserved — only the rep-editable sections
  // (prospect/icp/metrics/angle/context/situation/verbatim/titles) are overwritten.
  // Does NOT trigger any pipeline re-runs on its own — call /regenerate after.
  if (req.method === 'PATCH' && urlPath.match(/^\/api\/jobs\/[^/]+\/prospect-info$/)) {
    setCors(res);
    const jobId = urlPath.split('/')[3];
    try {
      const body = await parseBody(req);
      const patch = { updated_at: new Date().toISOString() };
      const allowed = ['prospect_email','prospect_name','prospect_company','prospect_website','prospect_linkedin_url'];
      for (const f of allowed) {
        if (body[f] !== undefined) {
          let v = body[f];
          if (typeof v === 'string') v = v.trim();
          if (f === 'prospect_website' && typeof v === 'string') {
            v = v.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
          }
          patch[f] = v || null;
        }
      }
      // Merge `brief` into existing extracted_data, preserving _meta and _overrides
      if (body.brief && typeof body.brief === 'object') {
        const existing = await getJob(jobId);
        const existingBrief = (existing && existing.extracted_data) || {};
        const newBrief = body.brief;
        patch.extracted_data = {
          ...existingBrief,                 // start from existing (preserves _meta, _overrides, _generated)
          prospect:  newBrief.prospect  ?? existingBrief.prospect,
          icp:       newBrief.icp       ?? existingBrief.icp,
          metrics:   newBrief.metrics   ?? existingBrief.metrics,
          angle:     newBrief.angle     ?? existingBrief.angle,
          context:   newBrief.context   ?? existingBrief.context,
          situation: newBrief.situation ?? existingBrief.situation,
          verbatim:  newBrief.verbatim  ?? existingBrief.verbatim,
          titles:    newBrief.titles    ?? existingBrief.titles
        };
      }
      const r = await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`, patch, { 'Prefer': 'return=representation' });
      if (r.status >= 400) throw new Error(`Supabase ${r.status}: ${JSON.stringify(r.body)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job: Array.isArray(r.body) ? r.body[0] : r.body }));
    } catch(e) {
      console.error('[PATCH /api/jobs/:id/prospect-info]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/jobs/:id/regenerate — re-run brand_scrape + prospect_research
  // and the personalization tasks downstream. Used after a rep edits prospect
  // info (website / LinkedIn URL) and wants the visual outputs refreshed. Resets
  // the relevant tasks to 'pending', clears their cached output, and lets the
  // worker pick them up. Upstream `extract` and `lead_list` are NOT touched —
  // they read the transcript and are independent of the prospect edits.
  if (req.method === 'POST' && urlPath.match(/^\/api\/jobs\/[^/]+\/regenerate$/)) {
    setCors(res);
    const jobId = urlPath.split('/')[3];
    try {
      const job = await getJob(jobId);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Job not found' })); return;
      }
      // Clear cached personalization data on the job record
      await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`, {
        brand_data:    null,
        research_data: null,
        status:        'processing',
        updated_at:    new Date().toISOString()
      });
      // Reset downstream tasks. Order doesn't matter — orchestrator handles deps.
      const tasks = await getTasksByJobId(jobId);
      const toReset = ['brand_scrape','prospect_research','webinar_titles','calendar_visual'];
      const resetIds = [];
      for (const t of tasks) {
        if (toReset.includes(t.task_type)) {
          await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${t.id}`, {
            status:        'pending',
            output_data:   null,
            asset_url:     null,
            error_message: null,
            started_at:    null,
            completed_at:  null,
            updated_at:    new Date().toISOString()
          });
          resetIds.push(t.task_type);
        }
      }
      console.log(`[POST /api/jobs/${jobId}/regenerate] Reset tasks: ${resetIds.join(', ')}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reset: resetIds }));
    } catch(e) {
      console.error('[POST /api/jobs/:id/regenerate]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/jobs/:id/rescan-brand-colors — ad-hoc re-run of the brand scrape
  // for the Webinar Experience tab. Lets the rep tweak prospect_website + pull
  // fresh primary/secondary/accent colors without resetting any other task or
  // touching the AI-generated webinar copy. Body `{ website? }` is optional —
  // if provided and different from the saved value, prospect_website is
  // updated first (same normalisation as /prospect-info). After scrape we drop
  // any existing webinar_*_color overrides so the freshly-scraped colors are
  // what the pickers display by default; the rep can still edit them after.
  if (req.method === 'POST' && urlPath.match(/^\/api\/jobs\/[^/]+\/rescan-brand-colors$/)) {
    setCors(res);
    const jobId = urlPath.split('/')[3];
    try {
      const body = await parseBody(req).catch(() => ({}));
      let job = await getJob(jobId);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Job not found' })); return;
      }
      // Optional website override from the rep — normalize the same way
      // /prospect-info does (strip protocol, lowercase domain).
      if (typeof body.website === 'string') {
        const normalized = body.website.trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase() || null;
        if (normalized !== job.prospect_website) {
          await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`, {
            prospect_website: normalized,
            updated_at:       new Date().toISOString()
          });
          job = { ...job, prospect_website: normalized };
        }
      }
      if (!job.prospect_website) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No prospect_website set on job — pass { website } in body or fill it via /prospect-info first.' }));
        return;
      }
      // Run the scrape — handleBrandScrape persists to jobs.brand_data itself.
      const brandData = await handleBrandScrape(null, job);
      // Drop any existing webinar_*_color overrides so the new scrape shows
      // through in the pickers. The rep can still adjust afterwards.
      const existingData      = job.extracted_data || {};
      const existingOverrides = existingData._overrides || {};
      const clearedOverrides  = { ...existingOverrides };
      delete clearedOverrides.webinar_primary_color;
      delete clearedOverrides.webinar_secondary_color;
      delete clearedOverrides.webinar_accent_color;
      clearedOverrides._updated_at = new Date().toISOString();
      await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
        { extracted_data: { ...existingData, _overrides: clearedOverrides }, updated_at: new Date().toISOString() },
        { 'Prefer': 'return=minimal' }
      );
      console.log(`[POST /api/jobs/${jobId}/rescan-brand-colors] website=${job.prospect_website} primary=${brandData.primary_color||'none'} secondary=${brandData.secondary_color||'none'} accent=${brandData.accent_color||'none'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, brand_data: brandData, prospect_website: job.prospect_website }));
    } catch(e) {
      console.error('[POST /api/jobs/:id/rescan-brand-colors]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/jobs/:id/assets/:asset — proxy the stored HTML with correct MIME
  // type. Supabase Storage forces Content-Type: text/plain + X-Content-Type-Options:
  // nosniff on every file in this public bucket (stored-XSS prevention), which makes
  // browsers render our generated webinar/calendar/ROI HTML as source code instead
  // of as a page. We re-serve the same body with Content-Type: text/html. Allowed
  // assets are gated to avoid this becoming an arbitrary-fetch endpoint.
  if (req.method === 'GET' && urlPath.match(/^\/api\/jobs\/[^/]+\/assets\/[a-z_]+$/)) {
    setCors(res);
    const parts = urlPath.split('/');
    const jobId = parts[3];
    const asset = parts[5];
    const allowed = { calendar_visual: 'calendar_visual.html', roi_model: 'roi_model.html' };
    const filename = allowed[asset];
    if (!filename) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Unknown asset: ${asset}. Allowed: ${Object.keys(allowed).join(', ')}`);
      return;
    }
    try {
      const storageUrl = `${SUPABASE_URL}/storage/v1/object/public/sales-assets/${encodeURIComponent(jobId)}/${filename}`;
      const upstream = await fetch(storageUrl, { signal: AbortSignal.timeout(10000) });
      if (!upstream.ok) {
        res.writeHead(upstream.status, { 'Content-Type': 'text/plain' });
        res.end(`Asset fetch failed (storage HTTP ${upstream.status}). The task may not have completed yet.`);
        return;
      }
      const body = await upstream.text();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Length': Buffer.byteLength(body, 'utf8')
      });
      res.end(body);
    } catch(e) {
      console.error(`[asset proxy] ${asset}/${jobId} error:`, e.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Asset proxy error: ' + e.message);
    }
    return;
  }

  // ── DELETE /api/jobs/:id — hard delete job + tasks ───────────────────────
  if (req.method === 'DELETE' && urlPath.startsWith('/api/jobs/')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length);
    try {
      // Delete tasks first (avoid FK constraint violation)
      await supabaseRequest('DELETE', `/rest/v1/tasks?job_id=eq.${jobId}`);
      const r = await supabaseRequest('DELETE', `/rest/v1/jobs?id=eq.${jobId}`);
      console.log(`[DELETE /api/jobs] Deleted job ${jobId} status=${r.status}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
    } catch(e) {
      console.error('[DELETE /api/jobs]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PATCH /api/jobs/:id/overrides — rep field override system ──────────────────
  // Stores rep manual edits in extracted_data._overrides (separate from AI-generated data).
  // Overrides persist across pipeline re-runs. Portal reads _overrides first, then _generated.
  // Allowed fields: tam_total, recommended_outreach, webinar_title, roi_ltv, roi_show_rate,
  //   roi_close_rate, webinar_logo_url, webinar_hero_image_url, webinar_headshot_url
  //   (the three webinar_* fields let the rep cherry-pick which scraped image goes
  //    in each visual slot of the webinar slide / mock).
  // ── POST /api/jobs/:id/upload-asset — rep uploads their own image ─────────
  // Rep-only flow from the Webinar Experience asset picker. Body is the raw
  // image binary (frontend sends a File object directly via fetch, no
  // multipart). Query params:
  //   ?slot=webinar_logo_url|webinar_hero_image_url|webinar_headshot_url
  //          (label only — used in the storage filename, doesn't gate
  //           anything; the rep wires the returned URL to whichever slot
  //           via the existing PATCH /overrides flow)
  //   ?filename=foo.png  (optional, used to derive the storage filename)
  // Headers: Content-Type must be one of the image/* whitelist below.
  // Returns: { ok, url, type, size, path }. The returned `url` is what the
  // frontend hands to wapSetOverride() so the rep edit lands as a normal
  // override — no special-casing for uploads anywhere downstream.
  if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/upload-asset$/.test(urlPath)) {
    setCors(res);
    const jobId = urlPath.split('/')[3];
    try {
      const job = await getJob(jobId);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Job not found' })); return;
      }
      const rawType = String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
      const ALLOWED_IMG = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml', 'image/gif'];
      if (!ALLOWED_IMG.includes(rawType)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Content-Type "${rawType}" not supported. Allowed: ${ALLOWED_IMG.join(', ')}` })); return;
      }
      let buf;
      try {
        buf = await parseBinaryBody(req, 10 * 1024 * 1024);
      } catch (e) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'Upload too large (max 10MB)' })); return;
      }
      if (!buf || buf.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Empty request body' })); return;
      }
      const qs = new URLSearchParams(req.url.split('?')[1] || '');
      const slot = (qs.get('slot') || 'asset').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40) || 'asset';
      const rawName = qs.get('filename') || 'upload';
      const safeName = String(rawName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60).replace(/\.[a-z0-9]+$/i, '');
      const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif' };
      const ext = extMap[rawType] || 'bin';
      const storagePath = `${jobId}/uploads/${Date.now()}-${slot}-${safeName}.${ext}`;
      const publicUrl   = await storageUpload(storagePath, buf, rawType);
      // Persist the upload to extracted_data._uploads so the asset picker can
      // surface it as a candidate on subsequent modal opens. Without this the
      // file lives in Storage and gets used as the current override, but
      // there's no record of it for cross-slot reuse or "pick from your
      // uploads" browsing. Dedupe by URL.
      const uploadRecord = {
        url:         publicUrl,
        filename:    rawName,
        slot,
        type:        rawType,
        size:        buf.length,
        path:        storagePath,
        uploaded_at: new Date().toISOString()
      };
      let uploadsList = [];
      try {
        const existingData    = job.extracted_data || {};
        const existingUploads = Array.isArray(existingData._uploads) ? existingData._uploads : [];
        uploadsList = existingUploads.filter(u => u && u.url !== publicUrl).concat([uploadRecord]);
        const updatedData = { ...existingData, _uploads: uploadsList };
        const pr = await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
          { extracted_data: updatedData, updated_at: new Date().toISOString() },
          { 'Prefer': 'return=minimal' });
        if (pr.status >= 400) {
          console.warn(`[POST /api/jobs/${jobId}/upload-asset] _uploads PATCH ${pr.status} — file uploaded but list not persisted: ${JSON.stringify(pr.body).slice(0,200)}`);
        }
      } catch (e) {
        console.warn(`[POST /api/jobs/${jobId}/upload-asset] _uploads append failed: ${e.message} — file uploaded but list not persisted`);
      }
      console.log(`[POST /api/jobs/${jobId}/upload-asset] ${rawType} (${buf.length}B) slot=${slot} → ${publicUrl} (uploads count: ${uploadsList.length})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: publicUrl, type: rawType, size: buf.length, path: storagePath, upload: uploadRecord, uploads: uploadsList }));
    } catch (e) {
      console.error('[POST /api/jobs/upload-asset]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'PATCH' && urlPath.startsWith('/api/jobs/') && urlPath.endsWith('/overrides')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length, -'/overrides'.length);
    try {
      const body = await parseBody(req);
      const ALLOWED = [
        'tam_total','recommended_outreach','webinar_title','roi_ltv','roi_show_rate','roi_close_rate',
        'webinar_logo_url','webinar_hero_image_url','webinar_headshot_url',
        // Per-variant calendar copy overrides (A/B/C). Set in rep edit mode from
        // the Calendar Invite tab. Empty string clears the override (falls back
        // to the AI-generated copy).
        'webinar_title_0','webinar_title_1','webinar_title_2',
        'webinar_desc_0','webinar_desc_1','webinar_desc_2',
        // Brand colors — rep can override the scraped values from the Brand
        // Assets gallery. Affect the hero gradient, accents, and (in slides
        // that pull from CSS vars) anything tied to --prospect-primary etc.
        // Empty string clears the override.
        'webinar_primary_color','webinar_secondary_color','webinar_accent_color',
      ];
      const safeOverrides = {};
      for (const k of ALLOWED) {
        if (body[k] !== undefined) safeOverrides[k] = body[k];
      }
      if (!Object.keys(safeOverrides).length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `No valid override fields. Allowed: ${ALLOWED.join(', ')}` }));
        return;
      }
      // Fetch current job to merge overrides
      const job = await getJob(jobId);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Job not found' })); return; }
      const existingData = job.extracted_data || {};
      const existingOverrides = existingData._overrides || {};
      const mergedOverrides = { ...existingOverrides, ...safeOverrides, _updated_at: new Date().toISOString() };
      const updatedData = { ...existingData, _overrides: mergedOverrides };
      const r = await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
        { extracted_data: updatedData, updated_at: new Date().toISOString() },
        { 'Prefer': 'return=minimal' }
      );
      if (r.status >= 400) throw new Error(`Supabase PATCH failed: ${r.status}`);
      console.log(`[PATCH /api/jobs/${jobId}/overrides] Saved:`, safeOverrides);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, overrides: mergedOverrides }));
    } catch(e) {
      console.error('[PATCH /api/jobs/overrides]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PATCH /api/jobs/:id/icp — update Apollo ICP filters manually ──────────
  if (req.method === 'PATCH' && urlPath.startsWith('/api/jobs/') && urlPath.endsWith('/icp')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length, -'/icp'.length);
    try {
      const body = await parseBody(req);
      const job = await getJob(jobId);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Job not found' })); return; }
      const existingData = job.extracted_data || {};
      const existingIcp = existingData.icp || {};
      const ICP_FIELDS = ['apollo_titles', 'apollo_keyword', 'apollo_geography', 'apollo_employee_ranges', 'person_seniorities', 'target_audience_type'];
      const updatedIcp = { ...existingIcp };
      for (const k of ICP_FIELDS) {
        if (body[k] !== undefined) updatedIcp[k] = body[k];
      }
      const updatedData = { ...existingData, icp: updatedIcp };
      const r = await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
        { extracted_data: updatedData, updated_at: new Date().toISOString() },
        { 'Prefer': 'return=minimal' }
      );
      if (r.status >= 400) throw new Error(`Supabase PATCH failed: ${r.status}`);
      console.log(`[PATCH /api/jobs/${jobId}/icp] Updated ICP filters`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, icp: updatedIcp }));
    } catch(e) {
      console.error('[PATCH /api/jobs/icp]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/sales-reps — list active reps (drives dashboard + portal UIs) ─
  if (req.method === 'GET' && urlPath === '/api/sales-reps') {
    setCors(res);
    try {
      const rows = await loadActiveReps();
      const reps = rows
        .filter(r => r.active)
        .map(r => ({ slug: r.slug, display_name: r.display_name }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reps }));
    } catch(e) {
      console.error('[GET /api/sales-reps]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/diag/ghl-users — list every GHL user in the location so the ──
  // seed SQL can be populated with real IDs. Quick one-off helper for first
  // setup; output is name + id + email pairs we can paste into UPDATEs.
  if (req.method === 'GET' && urlPath === '/api/diag/ghl-users') {
    setCors(res);
    if (!GHL_API_KEY || !GHL_LOCATION_ID) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'GHL_API_KEY / GHL_LOCATION_ID not set' })); return;
    }
    try {
      const url = `https://services.leadconnectorhq.com/users/?locationId=${GHL_LOCATION_ID}`;
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' },
        signal: AbortSignal.timeout(5000)
      });
      if (!r.ok) {
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `GHL /users returned ${r.status}`, body: await r.text() })); return;
      }
      const data = await r.json();
      const users = (data.users || []).map(u => ({
        id:    u.id,
        name:  [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.name || null,
        email: u.email || null
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: users.length, users }));
    } catch(e) {
      console.error('[GET /api/diag/ghl-users]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/admin/sync-rep-emails — pull sales rep emails from GHL ──────
  // One-shot sync: for every sales_reps row that has a ghl_user_id, fetch the
  // corresponding GHL user's email (and refresh display_name) and write back
  // to the sales_reps table. Used to populate the email column after the
  // one-time `ALTER TABLE sales_reps ADD COLUMN email TEXT` migration, and
  // whenever the team roster changes. Idempotent — only writes when GHL's
  // value differs from what's already stored. Boot-time auto-sync also calls
  // this when any active rep is missing an email.
  if (req.method === 'POST' && urlPath === '/api/admin/sync-rep-emails') {
    setCors(res);
    try {
      const result = await syncRepEmailsFromGHL();
      const status = result.ok ? 200 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[POST /api/admin/sync-rep-emails]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/diag/rep-resolve?email=… — walk the whole resolve chain and ──
  // return JSON. Useful when the New Job dropdown stays blank — you can see
  // exactly which step fell through (no contact, no opp, opp without owner,
  // owner without a sales_reps mapping, etc.). Returns ghl_user_id but no
  // secrets, so safe to leave un-gated.
  if (req.method === 'GET' && urlPath === '/api/diag/rep-resolve') {
    setCors(res);
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const email = (qs.get('email') || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'pass ?email=…' })); return;
    }
    // Always read sales_reps fresh on a diag hit. The 5-min cache otherwise
    // hides table edits made in Supabase, which is exactly when we want to
    // verify that an UPDATE landed.
    invalidateRepCache();
    try {
      const contact = await lookupGHLContact(email);
      const oppOwner = contact?.id ? await lookupGHLOpportunityOwner(contact.id) : null;
      const candidateUserId = oppOwner?.ghl_user_id || contact?.ghl_user_id || null;
      const repRow = candidateUserId ? await getRepByGhlUserId(candidateUserId) : null;
      const reps = await loadActiveReps();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        email,
        steps: {
          ghl_contact: contact ? {
            id: contact.id, name: contact.name, company: contact.company,
            contact_owner_user_id: contact.ghl_user_id || null
          } : null,
          ghl_opportunity: oppOwner ? {
            opportunity_id:   oppOwner.opportunity_id,
            opportunity_name: oppOwner.opportunity_name,
            opp_owner_user_id: oppOwner.ghl_user_id
          } : null,
          candidate_user_id: candidateUserId,
          candidate_source: oppOwner ? 'opportunity' : (contact?.ghl_user_id ? 'contact' : null),
          rep_lookup_result: repRow ? { slug: repRow.slug, display_name: repRow.display_name, active: repRow.active } : null
        },
        sales_reps_table: reps.map(r => ({
          slug: r.slug, display_name: r.display_name, ghl_user_id: r.ghl_user_id, active: r.active
        }))
      }));
    } catch(e) {
      console.error('[GET /api/diag/rep-resolve]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PATCH /api/jobs/:id/rep — override sales rep on an existing job ────────
  // Body: { slug: 'melissa' | 'ryan' | 'armando' | null }
  // Validates against sales_reps to keep rep_name from drifting away from the
  // canonical slug set. Pass slug=null/empty to clear the assignment.
  if (req.method === 'PATCH' && urlPath.match(/^\/api\/jobs\/[^/]+\/rep$/)) {
    setCors(res);
    const jobId = urlPath.split('/')[3];
    try {
      const body = await parseBody(req);
      const slug = (body.slug == null ? '' : String(body.slug)).trim().toLowerCase() || null;
      if (slug) {
        const rep = await getRepBySlug(slug);
        if (!rep) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown rep slug: ${slug}` }));
          return;
        }
      }
      const r = await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
        { rep_name: slug, updated_at: new Date().toISOString() },
        { 'Prefer': 'return=minimal' }
      );
      if (r.status >= 400) throw new Error(`Supabase PATCH failed: ${r.status}`);
      console.log(`[PATCH /api/jobs/${jobId}/rep] rep_name → ${slug || 'NULL'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, slug }));
    } catch(e) {
      console.error('[PATCH /api/jobs/:id/rep]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/jobs/:id/rerun-apollo — re-run lead search with current ICP ──
  if (req.method === 'POST' && urlPath.startsWith('/api/jobs/') && urlPath.endsWith('/rerun-apollo')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length, -'/rerun-apollo'.length);
    try {
      const job = await getJob(jobId);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Job not found' })); return; }
      const icp = (job.extracted_data || {}).icp || {};
      const hasKeyword = (typeof icp.apollo_keyword === 'string' && icp.apollo_keyword.trim().length > 0)
        || (Array.isArray(icp.apollo_industries) && icp.apollo_industries.length > 0); // legacy
      if (!icp.apollo_titles?.length && !hasKeyword) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No ICP filters set — nothing to search' }));
        return;
      }
      // Run the Apollo search (async — respond immediately, save results when done)
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Apollo search started — poll job status for results' }));
      // Background: run search and save results
      (async () => {
        // Throttled progress writer — at most one DB patch per 700ms unless progress
        // hits 100. The frontend polls every 2s anyway, so finer-grained writes burn
        // Supabase round-trips for no visible benefit.
        let lastWrite = 0;
        const writeProgress = async (snapshot) => {
          const now = Date.now();
          const isFinal = snapshot.progress >= 100 || snapshot.status === 'completed' || snapshot.status === 'failed';
          if (!isFinal && now - lastWrite < 700) return;
          lastWrite = now;
          try {
            const fresh = await getJob(jobId);
            const ext = fresh?.extracted_data || {};
            const updated = {
              ...ext,
              _generated: {
                ...(ext._generated || {}),
                apollo_rerun: { ...snapshot, updated_at: new Date().toISOString() }
              }
            };
            await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
              { extracted_data: updated },
              { 'Prefer': 'return=minimal' }
            );
          } catch (e) {
            // Progress writes are best-effort — never fail the search because we couldn't update progress
            console.warn('[rerun-apollo] progress write failed:', e.message);
          }
        };
        try {
          console.log(`[rerun-apollo] Starting for job ${jobId}`);
          await writeProgress({ status: 'running', progress: 5, message: 'Starting Apollo search…' });
          const result = await fetchLeadsFromApollo(icp, snapshot =>
            writeProgress({ status: 'running', ...snapshot })
          );
          if (result && result.leads) {
            // Force the 95% write through even if it fell within the 700ms throttle.
            lastWrite = 0;
            await writeProgress({ status: 'running', progress: 95, message: 'Saving results…' });
            // Mirror handleLeadList's outreach calculation so the "Recommended/month"
            // stat refreshes with the rerun. TAM > 300K → cap at 100K/mo;
            // otherwise exhaust the market in 3 months.
            const tam = result.total || 0;
            const recommendedOutreach = tam > 300000
              ? 100000
              : tam > 0 ? Math.max(1000, Math.round(tam / 3 / 1000) * 1000) : 30000;

            // Dedup + size fallback + people-match — same shared helper
            // handleLeadList uses, so a rerun produces an identically-shaped list
            // (25 unique-company leads, real names + emails baked in from the match
            // call). Cache hits from prior jobs for this prospect skip the Apollo
            // call entirely; brand-new leads still cost 1 credit each.
            const enrichmentCache = await getCachedApolloEnrichments(job.prospect_email, job.id);
            if (enrichmentCache.size) {
              console.log(`[rerun-apollo] Apollo enrichment cache: ${enrichmentCache.size} leads from prior jobs for ${job.prospect_email}`);
            }
            const { leads: finalizedLeads } = await finalizeLeadList(result.leads, icp, enrichmentCache);
            console.log(`[rerun-apollo] Dedup: ${result.leads.length} → ${finalizedLeads.length} unique-company leads`);

            // Re-read latest extracted_data so we don't clobber progress writes that
            // landed during the search (writeProgress patches extracted_data too).
            const fresh = await getJob(jobId);
            const existingData = fresh?.extracted_data || {};
            // Field names here MUST match what mockup-portal.html reads from
            // existingGen (see line ~2074: `existingGen.leads`, `tam_total`, etc).
            const updatedData = {
              ...existingData,
              _generated: {
                ...(existingData._generated || {}),
                leads:                finalizedLeads,
                tam_total:            tam,
                adjacent_tam_total:   result.adjacent_total ?? null,
                tam_source:           result.tamSource,
                recommendedOutreach:  recommendedOutreach,
                leadsTaskStatus:     'completed',
                apollo_diagnostics:   result.diagnostics,
                apollo_rerun:         {
                  status:     'completed',
                  progress:   100,
                  message:    `Done — ${finalizedLeads.length} leads, TAM ${tam.toLocaleString()}`,
                  finished_at: new Date().toISOString()
                }
              }
            };
            await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
              { extracted_data: updatedData, updated_at: new Date().toISOString() },
              { 'Prefer': 'return=minimal' }
            );
            console.log(`[rerun-apollo] Job ${jobId}: saved ${result.leads.length} leads, TAM=${tam}, outreach=${recommendedOutreach}/mo`);
          } else {
            console.warn(`[rerun-apollo] Job ${jobId}: search returned no result`);
            await writeProgress({ status: 'failed', progress: 100, message: 'Apollo search returned no result.' });
          }
        } catch(e) {
          console.error(`[rerun-apollo] Job ${jobId} error:`, e.message);
          await writeProgress({ status: 'failed', progress: 100, message: 'Search failed: ' + e.message });
        }
      })();
    } catch(e) {
      console.error('[POST /api/jobs/rerun-apollo]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/jobs/:id/leads/reveal — on-demand person enrichment (1 credit) ──
  // Body: { apollo_id: "..." }. Calls Apollo people/match by id (no reveal flags
  // for email/phone — work email comes back free in the default match response;
  // personal email and phone require reveal flags we never set). Costs exactly
  // 1 enrichment credit per call. Idempotent: if a lead is already revealed,
  // returns the existing data without spending another credit.
  if (req.method === 'POST' && urlPath.startsWith('/api/jobs/') && urlPath.endsWith('/leads/reveal')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length, -'/leads/reveal'.length);
    try {
      const body = await parseBody(req);
      const apolloId = (body.apollo_id || '').trim();
      if (!apolloId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'apollo_id required' })); return;
      }
      const job = await getJob(jobId);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Job not found' })); return;
      }
      const existingData = job.extracted_data || {};
      // Source-of-truth resolution mirrors buildCompatSession in mockup-portal.html:
      // _generated.leads wins; fall back to lead_list task output. We always write
      // back to _generated so future reads pick up the revealed fields.
      let leads = existingData._generated?.leads;
      if (!Array.isArray(leads) || leads.length === 0) {
        const taskRes = await supabaseRequest(
          'GET',
          `/rest/v1/tasks?job_id=eq.${jobId}&task_type=eq.lead_list&select=output_data&limit=1`
        );
        leads = taskRes.body?.[0]?.output_data?.leads || [];
      }
      const idx = leads.findIndex(l => l && l.apollo_id === apolloId);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Lead not found in this job' })); return;
      }
      if (leads[idx].revealed) {
        // Already revealed — return current state, do not re-spend the credit.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lead: leads[idx], cached: true })); return;
      }
      const apolloKey = process.env.APOLLO_API_KEY;
      const matchRes = await fetch('https://api.apollo.io/api/v1/people/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apolloKey },
        body: JSON.stringify({ id: apolloId }),  // NO reveal_phone_number, NO reveal_personal_emails
        signal: AbortSignal.timeout(10000)
      });
      if (!matchRes.ok) {
        console.error(`[reveal] Apollo HTTP ${matchRes.status} for ${apolloId}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Apollo enrichment failed' })); return;
      }
      const matchData = await matchRes.json();
      const p = matchData.person || {};
      const fullName = (p.first_name && p.last_name)
        ? `${p.first_name} ${p.last_name}`.trim()
        : (p.name || leads[idx].name);
      // Reveal scope: full name + work email + real employee count.
      // The employee count rides along for free in people/match — the search
      // endpoint strips it, but the match response (the 1-credit reveal call)
      // returns the full organization block with estimated_num_employees. We
      // capture it here and let it override the band fallback ("1–50 emp" from
      // the ICP filter) with a real number like "130 emp". No extra credit cost.
      // We still do NOT swap linkedin_url (company URL stays), and we still
      // skip photo_url / headline — kept that scope unchanged.
      const employeeCount = p.organization?.estimated_num_employees;
      const updatedLead = {
        ...leads[idx],
        name:     fullName,
        email:    p.email || null,
        revealed: true
      };
      if (Number.isFinite(employeeCount) && employeeCount > 0) {
        updatedLead.company_size = fmtEmp(employeeCount);
      }
      // Same email-domain → website override as the bulk peopleMatchAllLeads
      // path — when the work email is non-free-mail and matches the company
      // name, prefer it over the DDG proxy result.
      if (updatedLead.email) {
        const emailDomain = (updatedLead.email.split('@')[1] || '').toLowerCase().trim();
        if (emailDomain && !isFreeMailDomain(emailDomain) && emailDomainMatchesCompany(emailDomain, updatedLead.company)) {
          updatedLead.website = 'https://' + emailDomain;
        }
      }
      leads[idx] = updatedLead;
      // Persist the mutated leads array back into _generated.
      const updatedData = {
        ...existingData,
        _generated: { ...(existingData._generated || {}), leads }
      };
      await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
        { extracted_data: updatedData, updated_at: new Date().toISOString() },
        { 'Prefer': 'return=minimal' }
      );
      console.log(`[reveal] Job ${jobId} lead ${apolloId}: revealed → ${fullName} (1 credit)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lead: updatedLead, cached: false }));
    } catch(e) {
      console.error('[POST /api/jobs/leads/reveal]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/generate — backwards-compat shim → creates job, polls extract ─
  if (req.method === 'POST' && urlPath === '/api/generate') {
    setCors(res);
    try {
      const body       = await parseBody(req);
      const email      = (body.email || '').trim().toLowerCase();
      const websiteUrl = (body.websiteUrl || '').trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase();

      if (!email || !email.includes('@')) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Valid email required' })); return;
      }

      // Create job + Stage 1 tasks
      const job = await createJob(email, websiteUrl || null, null);
      await createTasks(job.id, ['extract', 'prospect_research']);

      // Poll until extract completes or 90s timeout
      const deadline = Date.now() + 90000;
      let finalJob = null;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        finalJob = await getJob(job.id);
        if (finalJob?.extracted_data) break;
      }

      const extracted  = finalJob?.extracted_data || {};
      const company    = extracted.prospect?.company || websiteUrl || email.split('@')[1];
      const name       = extracted.prospect?.contact_name || extracted.prospect?.name || null;
      const industry   = extracted.icp?.industry || 'consulting';
      const meta       = extracted._meta || {};

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        job_id:          job.id,
        sessionToken:    job.id,  // portal reads ?job= or ?session= — both supported
        company,
        name,
        industry,
        transcriptFound: meta.transcript?.found || false,
        websiteScraped:  meta.website?.scraped  || false,
        portalUrl:       `/?job=${job.id}`
      }));
    } catch(err) {
      console.error('[/api/generate]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/prompts — list all prompts ─────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/prompts') {
    setCors(res);
    try {
      const r = await supabaseRequest('GET', '/rest/v1/prompts?order=category.asc,slug.asc');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/prompts/:slug — single prompt ──────────────────────────────────
  if (req.method === 'GET' && urlPath.startsWith('/api/prompts/') && !urlPath.endsWith('/history')) {
    setCors(res);
    const slug = decodeURIComponent(urlPath.slice('/api/prompts/'.length));
    try {
      const r = await supabaseRequest('GET', `/rest/v1/prompts?slug=eq.${encodeURIComponent(slug)}&limit=1`);
      const prompt = Array.isArray(r.body) ? r.body[0] : null;
      if (!prompt) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(prompt));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/prompts/:slug/history — version history ────────────────────────
  if (req.method === 'GET' && urlPath.startsWith('/api/prompts/') && urlPath.endsWith('/history')) {
    setCors(res);
    const slug = decodeURIComponent(urlPath.slice('/api/prompts/'.length, -'/history'.length));
    try {
      const pr = await supabaseRequest('GET', `/rest/v1/prompts?slug=eq.${encodeURIComponent(slug)}&limit=1`);
      const prompt = Array.isArray(pr.body) ? pr.body[0] : null;
      if (!prompt) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      const vr = await supabaseRequest('GET', `/rest/v1/prompt_versions?prompt_id=eq.${prompt.id}&order=version.desc`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(vr.body));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PUT /api/prompts/:slug — update prompt + save version ───────────────────
  if (req.method === 'PUT' && urlPath.startsWith('/api/prompts/')) {
    setCors(res);
    const slug = decodeURIComponent(urlPath.slice('/api/prompts/'.length));
    try {
      const body = await parseBody(req);
      const pr = await supabaseRequest('GET', `/rest/v1/prompts?slug=eq.${encodeURIComponent(slug)}&limit=1`);
      const prompt = Array.isArray(pr.body) ? pr.body[0] : null;
      if (!prompt) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      const newVersion = prompt.version + 1;
      // Save current version to history
      await supabaseRequest('POST', '/rest/v1/prompt_versions', {
        prompt_id:      prompt.id,
        version_number: prompt.version,
        content:        prompt.content,
        notes:          prompt.notes   || null,
        created_by:     prompt.updated_by || 'system'
      });
      // Update the prompt
      await supabaseRequest('PATCH', `/rest/v1/prompts?id=eq.${prompt.id}`, {
        content: body.content || prompt.content,
        notes: body.notes || null,
        updated_by: body.updated_by || 'sales_rep',
        version: newVersion,
        updated_at: new Date().toISOString()
      }, { 'Prefer': 'return=minimal' });
      console.log(`[prompts] Updated ${slug} to v${newVersion}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: newVersion }));
    } catch(e) {
      console.error('[PUT /api/prompts]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Copy Brain — Examples CRUD ────────────────────────────────────────────
  // Same shape as principles but with { label, content } instead of just text.
  // GET /api/copy-brain/examples — list ordered by position
  if (req.method === 'GET' && urlPath === '/api/copy-brain/examples') {
    setCors(res);
    try {
      const r = await supabaseRequest('GET', '/rest/v1/copy_brain_examples?order=position.asc');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body || []));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/copy-brain/examples — create { title, description, enabled?, position? }
  if (req.method === 'POST' && urlPath === '/api/copy-brain/examples') {
    setCors(res);
    try {
      const body = await parseBody(req);
      // Accept legacy {label, content} for backward compat with any in-flight clients
      const title = (body.title || body.label || '').trim();
      const description = (body.description || body.content || '').trim();
      if (!title || !description) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'title and description required' })); return;
      }
      let position = body.position;
      if (typeof position !== 'number') {
        const maxR = await supabaseRequest('GET', '/rest/v1/copy_brain_examples?select=position&order=position.desc&limit=1');
        position = ((maxR.body && maxR.body[0] && maxR.body[0].position) || 0) + 1;
      }
      const r = await supabaseRequest('POST', '/rest/v1/copy_brain_examples',
        { title, description, enabled: body.enabled !== false, position },
        { 'Prefer': 'return=representation' }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(r.body) ? r.body[0] : r.body));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // PATCH /api/copy-brain/examples/:id
  if (req.method === 'PATCH' && urlPath.startsWith('/api/copy-brain/examples/')) {
    setCors(res);
    const id = urlPath.slice('/api/copy-brain/examples/'.length);
    try {
      const body = await parseBody(req);
      const patch = { updated_at: new Date().toISOString() };
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.description === 'string') patch.description = body.description;
      // Legacy aliases
      if (typeof body.label === 'string' && patch.title === undefined) patch.title = body.label;
      if (typeof body.content === 'string' && patch.description === undefined) patch.description = body.content;
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.position === 'number') patch.position = body.position;
      const r = await supabaseRequest('PATCH', `/rest/v1/copy_brain_examples?id=eq.${encodeURIComponent(id)}`,
        patch, { 'Prefer': 'return=representation' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(r.body) ? r.body[0] : r.body));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // DELETE /api/copy-brain/examples/:id
  if (req.method === 'DELETE' && urlPath.startsWith('/api/copy-brain/examples/')) {
    setCors(res);
    const id = urlPath.slice('/api/copy-brain/examples/'.length);
    try {
      await supabaseRequest('DELETE', `/rest/v1/copy_brain_examples?id=eq.${encodeURIComponent(id)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Copy Brain — Principles CRUD ──────────────────────────────────────────
  // GET /api/copy-brain/principles — list ordered by position
  if (req.method === 'GET' && urlPath === '/api/copy-brain/principles') {
    setCors(res);
    try {
      const r = await supabaseRequest('GET', '/rest/v1/copy_brain_principles?order=position.asc');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body || []));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/copy-brain/principles — create { text, enabled?, position? }
  if (req.method === 'POST' && urlPath === '/api/copy-brain/principles') {
    setCors(res);
    try {
      const body = await parseBody(req);
      const text = (body.text || '').trim();
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text required' })); return;
      }
      // Default position: tail of the list
      let position = body.position;
      if (typeof position !== 'number') {
        const maxR = await supabaseRequest('GET', '/rest/v1/copy_brain_principles?select=position&order=position.desc&limit=1');
        position = ((maxR.body && maxR.body[0] && maxR.body[0].position) || 0) + 1;
      }
      const r = await supabaseRequest('POST', '/rest/v1/copy_brain_principles',
        { text, enabled: body.enabled !== false, position },
        { 'Prefer': 'return=representation' }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(r.body) ? r.body[0] : r.body));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // PATCH /api/copy-brain/principles/:id — update text/enabled/position
  if (req.method === 'PATCH' && urlPath.startsWith('/api/copy-brain/principles/')) {
    setCors(res);
    const id = urlPath.slice('/api/copy-brain/principles/'.length);
    try {
      const body = await parseBody(req);
      const patch = { updated_at: new Date().toISOString() };
      if (typeof body.text === 'string') patch.text = body.text;
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.position === 'number') patch.position = body.position;
      const r = await supabaseRequest('PATCH', `/rest/v1/copy_brain_principles?id=eq.${encodeURIComponent(id)}`,
        patch, { 'Prefer': 'return=representation' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(r.body) ? r.body[0] : r.body));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // DELETE /api/copy-brain/principles/:id
  if (req.method === 'DELETE' && urlPath.startsWith('/api/copy-brain/principles/')) {
    setCors(res);
    const id = urlPath.slice('/api/copy-brain/principles/'.length);
    try {
      await supabaseRequest('DELETE', `/rest/v1/copy_brain_principles?id=eq.${encodeURIComponent(id)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/copy-brain/config — singleton { business_context, format_rules }
  if (req.method === 'GET' && urlPath === '/api/copy-brain/config') {
    setCors(res);
    try {
      const r = await supabaseRequest('GET', '/rest/v1/copy_brain_config?order=id.asc&limit=1');
      const row = (Array.isArray(r.body) ? r.body[0] : null) || { business_context: '', format_rules: '' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(row));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // PUT /api/copy-brain/config — update singleton (creates if missing)
  if (req.method === 'PUT' && urlPath === '/api/copy-brain/config') {
    setCors(res);
    try {
      const body = await parseBody(req);
      const patch = { updated_at: new Date().toISOString() };
      if (typeof body.business_context === 'string') patch.business_context = body.business_context;
      if (typeof body.format_rules === 'string') patch.format_rules = body.format_rules;
      const existing = await supabaseRequest('GET', '/rest/v1/copy_brain_config?order=id.asc&limit=1');
      const row = Array.isArray(existing.body) ? existing.body[0] : null;
      if (row) {
        const r = await supabaseRequest('PATCH', `/rest/v1/copy_brain_config?id=eq.${row.id}`, patch, { 'Prefer': 'return=representation' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(r.body) ? r.body[0] : r.body));
      } else {
        const r = await supabaseRequest('POST', '/rest/v1/copy_brain_config', patch, { 'Prefer': 'return=representation' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(r.body) ? r.body[0] : r.body));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/jobs/:id/regenerate/webinar-titles ──────────────────────────
  // Re-runs the webinar_titles generator against the current Copy Brain.
  // Mirrors the rerun-apollo pattern: respond 202 immediately, run async,
  // write progress to extracted_data._generated.webinar_rerun every poll.
  // On success, patches both the tasks.webinar_titles.output_data row AND
  // _generated.webinarTitles so the portal hot-reloads in place.
  if (req.method === 'POST' && urlPath.startsWith('/api/jobs/') && urlPath.endsWith('/regenerate/webinar-titles')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length, -'/regenerate/webinar-titles'.length);
    try {
      // Parse body before sending 202 — once the response is finalized the
      // request stream can be discarded. Body is optional; the legacy callers
      // POST with no payload, the Calendar Invite chat input adds { prompt }.
      const body = await parseBody(req).catch(() => ({}));
      const customInstructions = (body && typeof body.prompt === 'string') ? body.prompt.slice(0, 800).trim() : '';
      const job = await getJob(jobId);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Job not found' })); return; }
      const extracted = job.extracted_data || {};
      if (!extracted.icp && !extracted.prospect) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Job has no extracted_data — run extract first' })); return;
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Regeneration started — poll job for progress' }));

      (async () => {
        const writeRerun = async (snapshot) => {
          try {
            const fresh = await getJob(jobId);
            const ext   = fresh?.extracted_data || {};
            const updated = {
              ...ext,
              _generated: {
                ...(ext._generated || {}),
                webinar_rerun: { ...snapshot, updated_at: new Date().toISOString() }
              }
            };
            await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
              { extracted_data: updated }, { 'Prefer': 'return=minimal' });
          } catch (e) { console.warn('[regen-webinar-titles] progress write failed:', e.message); }
        };
        try {
          console.log(`[regen-webinar-titles] Starting for job ${jobId}`);
          await writeRerun({ status: 'running', progress: 10, message: 'Loading Copy Brain…' });
          const company = extracted.prospect?.company || job.prospect_company || 'Your Company';
          await writeRerun({ status: 'running', progress: 30, message: customInstructions ? 'Calling Claude Sonnet with rep prompt…' : 'Calling Claude Sonnet…' });
          const result = await generateWebinarTitles(extracted, company, job, customInstructions);
          await writeRerun({ status: 'running', progress: 90, message: 'Saving variants…' });

          // 1) Update the task row so portal's primary read path picks it up.
          // Column is `error_message` (not `error`) — passing the wrong column made
          // PostgREST reject the entire PATCH, leaving the task with the older
          // output schema while the _generated mirror updated correctly. Log the
          // status code so any future schema mismatch surfaces immediately instead
          // of silently masking the new copy with stale task output.
          const taskR = await supabaseRequest('GET', `/rest/v1/tasks?job_id=eq.${jobId}&task_type=eq.webinar_titles&limit=1`);
          const taskRow = Array.isArray(taskR.body) ? taskR.body[0] : null;
          if (taskRow) {
            const patchR = await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${taskRow.id}`,
              { output_data: result, status: 'completed', error_message: null, updated_at: new Date().toISOString() },
              { 'Prefer': 'return=minimal' });
            if (patchR.status >= 400) {
              console.error(`[regen-webinar-titles] Task PATCH FAILED status=${patchR.status} body=${JSON.stringify(patchR.body).slice(0,400)}`);
            }
          } else {
            console.warn(`[regen-webinar-titles] No webinar_titles task row found for job ${jobId} — only the mirror was updated`);
          }
          // 2) Cascade — reset downstream tasks that depend on webinar_titles so they
          // re-run with the fresh variants. Without this the rendered calendar HTML
          // asset stays frozen on the previous run's output, even though the variant
          // text in the modal updates from the mirror. The worker picks up the reset
          // rows within 3s because their dependency (webinar_titles) is now completed
          // with new output.
          await writeRerun({ status: 'running', progress: 92, message: 'Re-running calendar visual…' });
          const downstreamTypes = ['calendar_visual'];
          for (const t of downstreamTypes) {
            try {
              const r = await supabaseRequest(
                'PATCH',
                `/rest/v1/tasks?job_id=eq.${jobId}&task_type=eq.${t}`,
                { status: 'pending', error_message: null, output_data: null, asset_url: null, attempts: 0, updated_at: new Date().toISOString() },
                { 'Prefer': 'return=minimal' }
              );
              if (r.status >= 400) {
                console.warn(`[regen-webinar-titles] Cascade reset failed for ${t}: status=${r.status} body=${JSON.stringify(r.body).slice(0,200)}`);
              }
            } catch (e) {
              console.warn(`[regen-webinar-titles] Cascade reset error for ${t}: ${e.message}`);
            }
          }

          // 3) Mirror to _generated for redundancy + final progress flag
          const fresh = await getJob(jobId);
          const ext   = fresh?.extracted_data || {};
          const updated = {
            ...ext,
            _generated: {
              ...(ext._generated || {}),
              webinarTitles: result,
              webinar_rerun: {
                status: 'completed', progress: 100,
                message: 'Variants regenerated · downstream re-running',
                finished_at: new Date().toISOString()
              }
            }
          };
          await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
            { extracted_data: updated, updated_at: new Date().toISOString() },
            { 'Prefer': 'return=minimal' });
          console.log(`[regen-webinar-titles] Job ${jobId}: variants regenerated + downstream queued`);
        } catch (e) {
          console.error(`[regen-webinar-titles] Job ${jobId} error:`, e.message);
          await writeRerun({ status: 'failed', progress: 100, message: 'Regeneration failed: ' + e.message });
        }
      })();
    } catch (e) {
      console.error('[POST /api/jobs/regenerate/webinar-titles]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/portal-data — legacy session endpoint ────────────────────────
  if (req.method === 'GET' && urlPath === '/api/portal-data') {
    setCors(res);
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const token  = params.get('session') || params.get('job');
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'session or job param required' })); return;
    }
    try {
      const job   = await getJob(token);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      const extracted = job.extracted_data || {};
      const meta      = extracted._meta || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        email:      job.prospect_email,
        domain:     job.prospect_website,
        transcript: meta.transcript || { found: false },
        website:    meta.website    || { domain: job.prospect_website, scraped: false },
        extracted
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Lloyd avatar ──────────────────────────────────────────────────────────
  // Serves assets/lloyd-yip.jpg (or .png) directly. The previous LinkedIn-CDN
  // proxy stopped working because LinkedIn rotates signed image URLs and
  // blocks server-to-server fetches without proper session cookies. Local file
  // is the only stable option. Falls back to 404 if the file is missing so the
  // <img onerror> handler on the page degrades gracefully to the initials chip.
  if (urlPath === '/lloyd-avatar') {
    const candidates = ['lloyd-yip.jpg', 'lloyd-yip.jpeg', 'lloyd-yip.png'];
    for (const filename of candidates) {
      const filePath = path.join(__dirname, 'assets', filename);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filename);
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }
    console.warn('[lloyd-avatar] No file found at assets/lloyd-yip.{jpg,png}');
    res.writeHead(404); res.end();
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  if (urlPath === '/' || urlPath === '') urlPath = '/mockup-portal.html';
  if (urlPath === '/dashboard')          urlPath = '/mockup-dashboard.html';
  if (urlPath === '/calls')              urlPath = '/calls.html';
  if (urlPath === '/settings')           urlPath = '/settings.html';
  if (urlPath === '/prompts' || urlPath === '/prompts.html') urlPath = '/settings.html';  // legacy alias
  if (urlPath === '/prospect' || urlPath.startsWith('/prospect?')) urlPath = '/prospect.html';
  const filePath = path.join(__dirname, urlPath);
  const ext      = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const isHtml = (MIME[ext] || '').includes('html');
    const headers = { 'Content-Type': MIME[ext] || 'text/plain' };
    if (isHtml) headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Deal Forge running on port ${PORT}`);
  console.log(`Supabase: ${USE_SUPABASE ? 'connected' : 'NOT configured — worker disabled'}`);
  // Auto-sync sales_reps.email from GHL on boot — but only if at least one
  // active rep is missing an email. This makes the speaker-labeling pipeline
  // self-healing: after the one-time SQL migration the next redeploy fills in
  // emails without any operator action. Fire-and-forget; failures are logged
  // but never block startup or block worker tasks.
  if (USE_SUPABASE && GHL_API_KEY && GHL_LOCATION_ID) {
    setTimeout(async () => {
      try {
        const reps = await loadActiveReps();
        const needsSync = reps.some(r => r.active && r.ghl_user_id && !r.email);
        if (!needsSync) {
          console.log('[boot-sync] sales_reps emails already populated; skipping GHL sync');
          return;
        }
        console.log('[boot-sync] sales_reps missing email — syncing from GHL…');
        const result = await syncRepEmailsFromGHL();
        if (result.ok) {
          console.log(`[boot-sync] Done — ${result.synced} updated, ${result.missing} still missing`);
        } else {
          console.warn('[boot-sync] Failed:', result.error);
        }
      } catch (e) {
        console.warn('[boot-sync] Error:', e.message);
      }
    }, 3000); // Brief delay so the server is fully ready before we hit GHL.
  }
});
