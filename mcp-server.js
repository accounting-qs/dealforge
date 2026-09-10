'use strict';
/**
 * Deal Forge — remote MCP server (Streamable HTTP, stateless).
 *
 * Lets an external agent (Grok, Claude, MCP Inspector, …) do exactly what a rep
 * can do in the browser: create jobs, edit the brief and ICP, set the rep-facing
 * overrides that the portal's edit mode writes, re-run pipeline stages, and hand
 * out the prospect-facing portal link.
 *
 * ── Design notes ────────────────────────────────────────────────────────────
 *
 * HAND-ROLLED JSON-RPC, NO DEPENDENCIES.
 *   @modelcontextprotocol/sdk was evaluated and rejected: it pulls 87 transitive
 *   packages (express 5, hono, jose, ajv, cors, express-rate-limit, zod) into an
 *   app that deliberately runs on three, and its Node transport is a wrapper over
 *   @hono/node-server which reads `req.rawHeaders` rather than `req.headers` —
 *   so the usual `req.headers.accept = …` interop fix is a silent no-op and the
 *   transport hard-406s any client that doesn't send both `application/json` and
 *   `text/event-stream` (webStandardStreamableHttp.js:471, no way to disable).
 *   A client only ever needs five methods here: initialize, notifications/*,
 *   ping, tools/list, tools/call. We own those and content-negotiate instead.
 *
 *   Escape hatch: the only export is handle(req, res, urlPath). Swap the
 *   internals for the SDK later and server.js does not change. Do that if you
 *   ever need server-initiated messages (sampling, elicitation) or real OAuth.
 *
 * TOOLS CALL THE APP OVER LOOPBACK HTTP.
 *   Route logic lives inline inside the if-chain in server.js and is not
 *   callable as functions. Going over 127.0.0.1 guarantees MCP behaviour can
 *   never drift from what the dashboard gets — same validation, same side
 *   effects, same envelopes — for one sub-millisecond local hop.
 *
 * STATELESS.
 *   No Mcp-Session-Id is ever issued. Render overlaps instances during a deploy,
 *   so a session pinned to one instance would 404 mid-conversation with no
 *   recovery path for an agent. A session id sent by a client is ignored, not
 *   rejected.
 *
 * Wire-up in server.js is one require plus one line, above the blanket OPTIONS
 * handler (that handler answers 204 for every path with a CORS allow-list that
 * omits Authorization, so an MCP preflight has to be intercepted before it):
 *     const mcp = require('./mcp-server');
 *     if (await mcp.handle(req, res, urlPath)) return;
 */

const crypto = require('crypto');

// ── Config ───────────────────────────────────────────────────────────────────

const MCP_PATH = '/mcp';

// Same expression as server.js:67 so the loopback target always matches.
const PORT = process.env.PORT || 3000;

// server.listen(PORT, '0.0.0.0') is IPv4-only. 'localhost' can resolve to ::1
// on a dual-stack container and yield ECONNREFUSED with no useful error.
const API_BASE = `http://127.0.0.1:${PORT}`;

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://deal-forge-angel.onrender.com')
  .replace(/\/+$/, '');

const MCP_TOKEN = String(process.env.DEALFORGE_MCP_TOKEN || '');
const TOKEN_OK  = MCP_TOKEN.length >= 32;

// Hard delete cascades to tasks and is unrecoverable, so it needs a second,
// deliberate switch on top of the per-call confirm flag.
const ALLOW_DELETE = String(process.env.DEALFORGE_MCP_ALLOW_DELETE || '') === '1';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL   = PROTOCOL_VERSIONS[0];

const MAX_BODY_BYTES    = 1024 * 1024;   // 1 MB
const MAX_RESULT_BYTES  = 90 * 1024;     // keep a single tool result out of context-blowout territory

if (!TOKEN_OK) {
  console.error(
    '[mcp] DEALFORGE_MCP_TOKEN is unset or shorter than 32 chars — %s will refuse all traffic with 503. ' +
    'Generate one with: openssl rand -hex 32', MCP_PATH
  );
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

function mcpCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
  // Expose is the one people forget: a browser fetch() cannot read a response
  // header cross-origin without it. We never emit a session id, but including it
  // means a future switch to sessions doesn't silently break browser clients.
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// timingSafeEqual throws on length mismatch, which would leak the token length.
// Hashing both sides to a fixed 32 bytes first is the standard constant-time
// string compare.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Writes its own 401/503 and returns false when the caller is not authorised. */
function requireBearer(req, res) {
  mcpCors(res, req.headers.origin);

  // Fail closed. Every other route in this app is open; if /mcp degraded to
  // "open" on a missing env var, one forgotten Render setting would expose job
  // creation and prospect PII. 503 rather than 401 so the operator looks at
  // configuration instead of hunting for a wrong token.
  if (!TOKEN_OK) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32002, message: 'MCP not configured: DEALFORGE_MCP_TOKEN is unset or too short.' }
    }));
    return false;
  }

  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
  if (!m || !safeEqual(m[1].trim(), MCP_TOKEN)) {
    const ip = req.socket && req.socket.remoteAddress;
    console.warn(`[mcp] auth failed from ${ip || 'unknown'} (${m ? 'bad token' : 'no bearer header'})`);
    // No `resource_metadata` — this is a static token, not OAuth. Advertising a
    // metadata URL we don't serve sends OAuth-capable clients into a discovery
    // dance that dead-ends.
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="deal-forge-mcp", error="invalid_token"'
    });
    // Identical body whether the header was missing or wrong.
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
    return false;
  }
  return true;
}

/**
 * Body reader with a size cap that throws on malformed JSON.
 * Deliberately not server.js's parseBody(), which resolves {} on a syntax error
 * (turning a parse failure into a confusing "Invalid Request") and has no size
 * limit — fine for same-origin UI traffic, wrong for an internet-facing endpoint.
 */
function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0, aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        req.destroy();
        return reject(new Error(`body exceeded ${maxBytes} bytes`));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return reject(new Error('empty body'));
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(new Error(`invalid JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

/**
 * Content-negotiated response. The MCP spec lets a server answer a POST with
 * either JSON or an SSE frame, so rather than demanding a particular Accept
 * header (the SDK's 406 trap) we just honour whatever the client asked for.
 * Works with `application/json`, `text/event-stream`, both, `*!/!*`, or nothing.
 */
function respond(req, res, status, payload) {
  mcpCors(res, req.headers.origin);

  if (payload === null) { res.writeHead(202); res.end(); return; }   // notifications only

  const accept    = String(req.headers.accept || '');
  const wantsSse  = accept.includes('text/event-stream');
  const wantsJson = accept.includes('application/json') || accept.includes('*/*') || accept.trim() === '';
  const body      = JSON.stringify(payload);

  if (wantsSse && !wantsJson) {
    // X-Accel-Buffering:no — Render's proxy buffers text/event-stream otherwise.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.end(`event: message\ndata: ${body}\n\n`);
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// ── Loopback call into this same process ─────────────────────────────────────

/**
 * Normalises the four envelope shapes the app actually returns into one result:
 *   { ok, status, kind, data, error }
 *
 * The important case is (c): several routes answer HTTP 200 with an error in the
 * body. Passing those through as success would hand an agent a "result" that is
 * actually a failure.
 */
async function callApi(method, apiPath, body, { timeoutMs = 30000 } = {}) {
  const init = {
    method,
    headers: { 'X-Internal-Call': 'mcp' },   // so a future auth layer can allow-list us
    signal: AbortSignal.timeout(timeoutMs)   // a wedged route must never wedge the MCP request
  };
  if (body != null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res, text;
  try {
    res  = await fetch(`${API_BASE}${apiPath}`, init);
    text = await res.text();
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      ok: false, status: 0, kind: timedOut ? 'timeout' : 'transport',
      error: timedOut
        ? `${method} ${apiPath} timed out after ${timeoutMs}ms`
        : `${method} ${apiPath}: ${e.message}`,
      data: null
    };
  }

  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* leave null */ }

  // (a) HTTP-level failure — the dominant pattern, { error } with a 4xx/5xx.
  if (res.status >= 400) {
    const msg = (parsed && (parsed.error || parsed.message)) || text.slice(0, 300) || `HTTP ${res.status}`;
    return {
      ok: false, status: res.status,
      kind: res.status === 404 ? 'not_found' : res.status < 500 ? 'bad_request' : 'server_error',
      error: String(msg), data: parsed
    };
  }

  // (b) 2xx that isn't JSON — e.g. the static fallthrough's text/plain "Not found".
  if (parsed === null) {
    return {
      ok: false, status: res.status, kind: 'bad_response',
      error: `Non-JSON response from ${apiPath}: ${text.slice(0, 200)}`, data: null
    };
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // (c) HTTP 200 carrying a failure. Real cases: GET /api/prefetch/:id and
    //     /api/extract-brief/:id return 200 with {status:'error'|'failed', error},
    //     and /api/zoom/test returns 200 with {connected:false, error}.
    if (parsed.error) {
      return { ok: false, status: res.status, kind: 'app_error', error: String(parsed.error), data: parsed };
    }
    if (parsed.ok === false) {
      return { ok: false, status: res.status, kind: 'app_error',
               error: String(parsed.message || 'operation failed'), data: parsed };
    }
    if (parsed.status === 'error' || parsed.status === 'failed') {
      return { ok: false, status: res.status, kind: 'app_error',
               error: String(parsed.error || `job ${parsed.status}`), data: parsed };
    }
    // (d) { ok:true, …payload } — strip the flag, keep the payload.
    if (parsed.ok === true) {
      const { ok, ...rest } = parsed;
      return { ok: true, status: res.status, data: rest };
    }
  }

  // (e) Bare array, or a plain object with no envelope.
  return { ok: true, status: res.status, data: parsed };
}

// ── Tool result helpers ──────────────────────────────────────────────────────

/**
 * Tool *execution* failures travel as isError:true inside a successful JSON-RPC
 * result. JSON-RPC error codes are reserved for protocol problems — a client
 * may abort the turn on those, but will show isError text to the model and let
 * it recover.
 */
function okResult(data) {
  return { content: [{ type: 'text', text: cap(JSON.stringify({ ok: true, data }, null, 2)) }] };
}
function failResult(code, message, extra) {
  const payload = { ok: false, error: { code, message, ...(extra || {}) } };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}
function fromApi(r) {
  return r.ok ? okResult(r.data) : failResult(String(r.kind || 'error').toUpperCase(), r.error, { http_status: r.status });
}

/** Truncate loudly rather than silently — everything here lands in the agent's context. */
function cap(text) {
  if (text.length <= MAX_RESULT_BYTES) return text;
  return text.slice(0, MAX_RESULT_BYTES) +
    `\n\n… [truncated at ${MAX_RESULT_BYTES} bytes — narrow the request, e.g. drop entries from "include" or lower "limit"]`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Several routes match on bare startsWith/endsWith, so a path fragment smuggled
 * into an id would be forwarded straight into a PostgREST filter. Validate the
 * shape before any concatenation.
 */
function jobId(args) {
  const id = String(args.job_id || '').trim();
  if (!UUID_RE.test(id)) throw new ToolError('INVALID_ARGUMENT', `job_id must be a UUID, got: ${id || '(empty)'}`);
  return id;
}

class ToolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Money- or data-destroying tools refuse to act without an explicit flag. */
function needConfirm(args, what) {
  if (args.confirm !== true) {
    throw new ToolError('CONFIRMATION_REQUIRED', `${what} Re-call with confirm: true to proceed.`);
  }
}

function audit(tool, args, outcome, ms) {
  // Argument *keys* only — values carry prospect PII.
  const keys = Object.keys(args || {}).filter(k => k !== 'confirm').join(',') || '-';
  console.log(
    `[mcp] tool=${tool} job=${args && args.job_id ? args.job_id : '-'} ` +
    `args=${keys} confirm=${args && args.confirm === true} ok=${outcome.ok} ms=${ms}` +
    (outcome.code ? ` code=${outcome.code}` : '')
  );
}

// ── Shaping helpers ──────────────────────────────────────────────────────────

function portalLinks(id) {
  return {
    prospect_url: `${PUBLIC_BASE_URL}/${id}/how-it-works`,
    editor_url:   `${PUBLIC_BASE_URL}/${id}/how-it-works?edit=true`,
    roi_model_rep_url:      `${PUBLIC_BASE_URL}/api/jobs/${id}/assets/roi_model`,
    roi_model_prospect_url: `${PUBLIC_BASE_URL}/api/jobs/${id}/assets/roi_model?view=prospect`,
    calendar_visual_url:    `${PUBLIC_BASE_URL}/api/jobs/${id}/assets/calendar_visual`
  };
}

/** Task map minus the (potentially enormous) per-task output blobs. */
function taskStatuses(tasks) {
  const out = {};
  for (const [type, t] of Object.entries(tasks || {})) {
    out[type] = { status: t && t.status, asset_url: (t && t.asset_url) || null, error: (t && t.error) || null };
  }
  return out;
}

/**
 * Compact view of a job. A full record with 25 enriched leads plus extracted_data
 * runs well past 100 KB, so heavy sections are opt-in via `include`.
 */
function summariseJob(job, include) {
  const inc  = new Set(include || []);
  const ed   = job.extracted_data || {};
  const gen  = ed._generated || {};
  const ovr  = ed._overrides || {};
  const leads = Array.isArray(gen.leads) ? gen.leads : null;

  const out = {
    job_id:      job.job_id,
    status:      job.status,
    prospect: {
      name:     job.prospect_name,
      company:  job.prospect_company,
      email:    job.prospect_email,
      website:  job.prospect_website,
      linkedin: job.prospect_linkedin_url
    },
    rep:         ed.rep_name || job.assigned_rep || null,
    tam_method:  ed.tam_method || 'apollo',
    created_at:  job.created_at,
    updated_at:  job.updated_at,
    tasks:       taskStatuses(job.tasks),
    headline: {
      tam_total:            ovr.tam_total ?? gen.tam_total ?? null,
      tam_source:           gen.tam_source || null,
      recommended_outreach: ovr.recommended_outreach ?? gen.recommendedOutreach ?? null,
      unique_companies:     gen.uniqueCompanies ?? null,
      lead_count:           leads ? leads.length : 0,
      lead_warning:         gen.lead_warning || null
    },
    override_count: Object.keys(ovr).filter(k => k !== '_updated_at').length,
    links: portalLinks(job.job_id),
    available_include: ['brief', 'icp', 'overrides', 'leads', 'webinar', 'roi', 'brand', 'research', 'apollo_diagnostics']
  };

  if (inc.has('brief')) {
    const { _generated, _overrides, _meta, _uploads, _provenance, ...brief } = ed;
    out.brief = brief;
  }
  if (inc.has('icp'))       out.icp = ed.icp || null;
  if (inc.has('overrides')) out.overrides = ovr;
  if (inc.has('leads'))     out.leads = leads || [];
  if (inc.has('webinar'))   out.webinar = gen.webinarTitles || (job.tasks && job.tasks.webinar_titles && job.tasks.webinar_titles.output) || null;
  if (inc.has('roi'))       out.roi = (job.tasks && job.tasks.roi_model && job.tasks.roi_model.output) || null;
  if (inc.has('brand'))     out.brand = job.brand_data || null;
  if (inc.has('research'))  out.research = job.research_data || null;
  if (inc.has('apollo_diagnostics')) out.apollo_diagnostics = gen.apollo_diagnostics || null;

  return out;
}

/** Poll an in-memory progress job (prefetch / extract-brief) to completion. */
async function pollProgress(path, id, waitSeconds) {
  const deadline = Date.now() + Math.max(1, waitSeconds) * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const r = await callApi('GET', `${path}/${encodeURIComponent(id)}`);
    if (!r.ok) return r;
    last = r.data;
    if (last && (last.status === 'done' || last.status === 'complete' || last.status === 'completed')) return r;
    await new Promise(rs => setTimeout(rs, 1500));
  }
  return {
    ok: true, status: 200,
    data: { ...(last || {}), _timed_out: true,
      _note: `Still running after ${waitSeconds}s. Re-call this tool with the id to keep polling. ` +
             `Progress lives in memory and is lost on redeploy or after ~10 minutes.` }
  };
}

// ── Tool definitions ─────────────────────────────────────────────────────────
// Each entry: { name, title, description, inputSchema (JSON Schema), annotations, run }

const S = {
  jobId:   { type: 'string', description: 'Deal Forge job UUID.' },
  confirm: { type: 'boolean', description: 'Must be true. Guards an action that spends money or destroys data.' },
  strArr:  { type: 'array', items: { type: 'string' } }
};

const BRIEF_SECTIONS = {
  prospect:  { type: 'object', additionalProperties: true, description: 'company, contact_name, contact_title, offering_name, offer_description, website' },
  icp:       { type: 'object', additionalProperties: true, description: 'role, target_audience_type, apollo_titles[], apollo_keyword[], industry, company_size, apollo_employee_ranges[], geography, apollo_geography[], apollo_person_locations[], apollo_revenue_range{min,max}, person_seniorities[], kpis' },
  metrics:   { type: 'object', additionalProperties: true, description: 'ltv, close_rate, show_rate' },
  angle:     { type: 'object', additionalProperties: true, description: 'pain, result, methodology, proof' },
  verbatim:  { type: 'object', additionalProperties: true, description: 'pain_quote, result_quote, goal_quote' },
  situation: { type: 'object', additionalProperties: true, description: 'current_lead_gen, revenue_range, team_size, biggest_challenge' },
  context:   { type: 'object', additionalProperties: true, description: 'goals, why_webinar' },
  titles:    { type: 'object', additionalProperties: true, description: 'a, b — webinar title seeds' }
};

const TOOLS = [
  // ── Read ───────────────────────────────────────────────────────────────────
  {
    name: 'list_jobs',
    title: 'List jobs',
    description:
      'List recent Deal Forge jobs, newest first. Returns identity, status and the prospect portal link for each. ' +
      'The underlying endpoint returns the 100 most recent; filters below are applied to that window.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'processing', 'completed', 'partial', 'failed', 'cancelled'],
                  description: 'Only jobs with this status.' },
        rep:    { type: 'string', description: 'Only jobs assigned to this rep slug (see list_sales_reps).' },
        query:  { type: 'string', description: 'Case-insensitive substring match on prospect email, company or name.' },
        limit:  { type: 'integer', minimum: 1, maximum: 100, default: 25 }
      }
    },
    async run(args) {
      const r = await callApi('GET', '/api/jobs');
      if (!r.ok) return fromApi(r);
      let rows = Array.isArray(r.data) ? r.data : [];
      if (args.status) rows = rows.filter(j => j.status === args.status);
      if (args.rep)    rows = rows.filter(j => (j.assigned_rep || '') === args.rep);
      if (args.query) {
        const q = String(args.query).toLowerCase();
        rows = rows.filter(j =>
          [j.prospect_email, j.prospect_company, j.prospect_name]
            .some(v => String(v || '').toLowerCase().includes(q)));
      }
      const total = rows.length;
      rows = rows.slice(0, args.limit || 25).map(j => ({
        ...j,
        prospect_url: `${PUBLIC_BASE_URL}/${j.job_id}/how-it-works`,
        editor_url:   `${PUBLIC_BASE_URL}/${j.job_id}/how-it-works?edit=true`
      }));
      return okResult({ count: rows.length, matched: total, jobs: rows });
    }
  },
  {
    name: 'get_job',
    title: 'Get job',
    description:
      'Full detail for one job: prospect identity, per-task pipeline status, headline TAM/outreach/lead numbers, ' +
      'override count and portal links. Heavy sections (brief, leads, webinar copy, ROI, brand, research) are ' +
      'omitted by default to keep the response small — request them explicitly via "include".',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      required: ['job_id'],
      properties: {
        job_id: S.jobId,
        include: { type: 'array', description: 'Extra sections to embed.',
                   items: { type: 'string', enum: ['brief', 'icp', 'overrides', 'leads', 'webinar', 'roi', 'brand', 'research', 'apollo_diagnostics'] } }
      }
    },
    async run(args) {
      const id = jobId(args);
      // GET /api/jobs/:id does not return the assigned rep — only the list
      // endpoint does. Fetch both so the agent can see who owns the job.
      const [r, listR] = await Promise.all([
        callApi('GET', `/api/jobs/${id}`),
        callApi('GET', '/api/jobs')
      ]);
      if (!r.ok) return fromApi(r);
      const row = listR.ok && Array.isArray(listR.data)
        ? listR.data.find(j => j.job_id === id) : null;
      return okResult(summariseJob({ ...r.data, assigned_rep: row ? row.assigned_rep : null }, args.include));
    }
  },
  {
    name: 'get_job_status',
    title: 'Get job status',
    description:
      'Lightweight poll: job status, per-task status, and progress for the two background reruns ' +
      '(Apollo lead search, webinar copy). Use this after create_job, start_or_continue_pipeline, ' +
      'rerun_apollo or regenerate_webinar_titles instead of get_job — it stays small enough to poll repeatedly.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', required: ['job_id'], properties: { job_id: S.jobId } },
    async run(args) {
      const id = jobId(args);
      const r = await callApi('GET', `/api/jobs/${id}`);
      if (!r.ok) return fromApi(r);
      const gen = (r.data.extracted_data || {})._generated || {};
      return okResult({
        job_id: r.data.job_id,
        status: r.data.status,
        tasks:  taskStatuses(r.data.tasks),
        async:  { apollo_rerun: gen.apollo_rerun || null, webinar_rerun: gen.webinar_rerun || null },
        updated_at: r.data.updated_at
      });
    }
  },
  {
    name: 'get_portal_links',
    title: 'Get shareable links',
    description:
      'Every URL for a job. prospect_url is the customer-facing portal — safe to send to the prospect. ' +
      'editor_url is the same page in rep edit mode (inline editing of TAM, ROI, calendar copy and brand colours); ' +
      'do not send that one to a prospect. Also returns the ROI calculator in both rep and prospect views, ' +
      'and the interactive calendar asset.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object', required: ['job_id'],
      properties: {
        job_id: S.jobId,
        tab: { type: 'string', description: 'Optional portal tab slug to deep-link to (default "how-it-works").' }
      }
    },
    async run(args) {
      const id = jobId(args);
      const r = await callApi('GET', `/api/jobs/${id}`);
      if (!r.ok) return fromApi(r);
      const links = portalLinks(id);
      if (args.tab) {
        const tab = String(args.tab).replace(/[^a-z0-9-]/gi, '');
        links.prospect_url = `${PUBLIC_BASE_URL}/${id}/${tab}`;
        links.editor_url   = `${PUBLIC_BASE_URL}/${id}/${tab}?edit=true`;
      }
      const tasks = taskStatuses(r.data.tasks);
      return okResult({
        job_id: id,
        prospect_company: r.data.prospect_company,
        ...links,
        asset_readiness: {
          roi_model:       tasks.roi_model ? tasks.roi_model.status : 'not_created',
          calendar_visual: tasks.calendar_visual ? tasks.calendar_visual.status : 'not_created'
        },
        note: 'Send prospect_url to the customer. editor_url exposes rep-only editing controls.'
      });
    }
  },
  {
    name: 'list_sales_reps',
    title: 'List sales reps',
    description:
      'All Deal Forge sales reps with slug, display name, active flag and job count, plus the number of unassigned jobs. ' +
      'The slug is what create_job and assign_rep expect.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { include_inactive: { type: 'boolean', default: true, description: 'Include deactivated reps.' } }
    },
    async run(args) {
      const r = await callApi('GET', '/api/sales-reps?all=1');
      if (!r.ok) return fromApi(r);
      const data = r.data || {};
      let reps = Array.isArray(data.reps) ? data.reps : [];
      if (args.include_inactive === false) reps = reps.filter(x => x.active !== false);
      return okResult({ count: reps.length, reps, unassigned_jobs: data.unassigned_jobs ?? null });
    }
  },
  {
    name: 'worker_status',
    title: 'Pipeline worker status',
    description:
      'Health of the background pipeline worker: current build, live instances, and whether a stale worker from an ' +
      'older deploy is still claiming tasks. Check this first if jobs are stuck in pending.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} },
    async run() { return fromApi(await callApi('GET', '/api/admin/worker-status')); }
  },

  // ── Create / edit (no spend) ───────────────────────────────────────────────
  {
    name: 'create_job',
    title: 'Create job',
    description:
      'Create a job and start the pipeline. Only "email" is required — the extract task finds the Call 1 transcript ' +
      'by email on its own (Fireflies/Zoom) and runs Claude extraction, so a bare email produces a fully populated job. ' +
      'Anything you pass in "brief" is treated as rep-confirmed and WINS over what extraction finds; blank fields get ' +
      'filled in. Returns immediately — poll with get_job_status. Spends Claude tokens and Apollo search on the pipeline.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      required: ['email'],
      properties: {
        email:        { type: 'string', description: 'Prospect email. Required.' },
        website:      { type: 'string', description: 'Prospect website. Defaults to the email domain unless it is free-mail.' },
        linkedin_url: { type: 'string' },
        rep_name:     { type: 'string', description: 'Sales rep slug from list_sales_reps.' },
        tam_method:   { type: 'string', enum: ['apollo', 'llm', 'llm_pure'], default: 'apollo',
                        description: 'apollo = exact Apollo count (default). llm = AI grounded in real Apollo probes. llm_pure = AI estimate, no probing.' },
        transcript_id:     { type: 'string', description: 'Specific transcript to use, instead of letting extract search.' },
        transcript_source: { type: 'string', enum: ['fireflies', 'zoom'], default: 'fireflies' },
        brief: { type: 'object', additionalProperties: true, properties: BRIEF_SECTIONS,
                 description: 'Optional rep-confirmed brief. Supplied non-empty values beat extracted ones.' }
      }
    },
    async run(args) {
      const email = String(args.email || '').trim();
      if (!email.includes('@')) throw new ToolError('INVALID_ARGUMENT', `email must be a valid address, got: ${email || '(empty)'}`);
      const r = await callApi('POST', '/api/jobs', {
        email,
        websiteUrl:        args.website,
        linkedin_url:      args.linkedin_url,
        repName:           args.rep_name,
        tam_method:        args.tam_method || 'apollo',
        transcript_id:     args.transcript_id,
        transcript_source: args.transcript_source || 'fireflies',
        transcript_picked_by: 'rep',
        brief:             args.brief || {}
      });
      if (!r.ok) return fromApi(r);
      const id = r.data && r.data.job_id;
      return okResult({
        job_id: id,
        ...(id ? portalLinks(id) : {}),
        pipeline: 'Stage 1 started (extract, prospect_research, lead_list). Poll get_job_status.'
      });
    }
  },
  {
    name: 'assign_rep',
    title: 'Assign sales rep',
    description: 'Assign or clear the sales rep on a job. Pass slug:null to unassign. Slugs come from list_sales_reps.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object', required: ['job_id'],
      properties: { job_id: S.jobId, slug: { type: ['string', 'null'], description: 'Rep slug, or null to unassign.' } }
    },
    async run(args) {
      const id = jobId(args);
      return fromApi(await callApi('PATCH', `/api/jobs/${id}/rep`, { slug: args.slug ?? null }));
    }
  },
  {
    name: 'update_brief',
    title: 'Update prospect info and brief',
    description:
      'Edit the prospect record and any brief section — the same fields the portal\'s Prospect Infos tab saves. ' +
      'Merges into the existing brief and preserves overrides and generated output. Triggers no reruns; ' +
      'follow with start_or_continue_pipeline if you want the assets rebuilt from the new brief.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object', required: ['job_id'],
      properties: {
        job_id: S.jobId,
        prospect_email:        { type: 'string' },
        prospect_name:         { type: 'string' },
        prospect_company:      { type: 'string' },
        prospect_website:      { type: 'string' },
        prospect_linkedin_url: { type: 'string' },
        brief: { type: 'object', additionalProperties: true, properties: BRIEF_SECTIONS,
                 description: 'Brief sections to merge.' }
      }
    },
    async run(args) {
      const id = jobId(args);
      const { job_id, ...rest } = args;
      if (!Object.keys(rest).length) throw new ToolError('INVALID_ARGUMENT', 'Provide at least one field to update.');
      const r = await callApi('PATCH', `/api/jobs/${id}/prospect-info`, rest);
      if (!r.ok) return fromApi(r);
      // The route echoes the raw Supabase row, which is a different shape from
      // GET /api/jobs/:id (no job_id, no tasks) — don't try to summarise it.
      const row = r.data && r.data.job ? r.data.job : {};
      return okResult({
        job_id: id,
        updated: Object.keys(rest),
        prospect: {
          name:     row.prospect_name,
          company:  row.prospect_company,
          email:    row.prospect_email,
          website:  row.prospect_website,
          linkedin: row.prospect_linkedin_url
        },
        note: 'No reruns were triggered. Call get_job for the full record, or start_or_continue_pipeline to rebuild assets from the new brief.'
      });
    }
  },
  {
    name: 'update_icp',
    title: 'Update Apollo ICP filters',
    description:
      'Set the Apollo targeting filters that drive the lead list and TAM. Changing these clears any manual TAM / ' +
      'recommended-outreach / full-market-cycle overrides, because they would no longer match. ' +
      'This only saves the filters — call rerun_apollo afterwards to actually re-fetch leads.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object', required: ['job_id'],
      properties: {
        job_id: S.jobId,
        apollo_titles:           { ...S.strArr, description: 'Job titles to target. Leads are balanced evenly across these.' },
        apollo_keyword:          { ...S.strArr, description: 'Industry keywords. Mirrored to icp.industry.' },
        apollo_geography:        { ...S.strArr, description: 'Company locations.' },
        apollo_person_locations: { ...S.strArr, description: 'Person-level locations (separate from company geo).' },
        apollo_employee_ranges:  { ...S.strArr, description: 'e.g. ["1,10","11,50"].' },
        person_seniorities:      { ...S.strArr, description: 'e.g. ["owner","founder","c_suite"].' },
        apollo_revenue_range:    { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } }, additionalProperties: false },
        target_audience_type:    { type: 'string' }
      }
    },
    async run(args) {
      const id = jobId(args);
      const { job_id, ...rest } = args;
      if (!Object.keys(rest).length) throw new ToolError('INVALID_ARGUMENT', 'Provide at least one ICP field to update.');
      return fromApi(await callApi('PATCH', `/api/jobs/${id}/icp`, rest));
    }
  },
  {
    name: 'set_overrides',
    title: 'Set rep overrides (portal edit mode)',
    description:
      'Write the manual overrides that the portal\'s edit mode sets — the rep-facing editor. These beat AI-generated ' +
      'values everywhere in the portal and survive pipeline reruns. Covers headline TAM numbers, the ROI calculator ' +
      'inputs, per-variant calendar copy (A/B/C), brand colours and the three image slots. ' +
      'Pass an empty string to clear a field back to the AI value. Setting tam_total or recommended_outreach ' +
      'automatically clears a now-stale full_market_cycle.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object', required: ['job_id'],
      properties: {
        job_id: S.jobId,
        tam_total:            { type: ['number', 'string'], description: 'Number, or a human form the rep might type such as "1.1M".' },
        recommended_outreach: { type: ['number', 'string'] },
        full_market_cycle:    { type: ['number', 'string'] },
        webinar_title:        { type: 'string', description: 'Headline webinar title override.' },
        roi_ltv:              { type: ['number', 'string'] },
        roi_show_rate:        { type: ['number', 'string'] },
        roi_close_rate:       { type: ['number', 'string'] },
        webinar_title_0: { type: 'string' }, webinar_desc_0: { type: 'string' },
        webinar_title_1: { type: 'string' }, webinar_desc_1: { type: 'string' },
        webinar_title_2: { type: 'string' }, webinar_desc_2: { type: 'string' },
        webinar_primary_color:   { type: 'string', description: 'Hex, e.g. "#1a2b3c", or "" to clear.' },
        webinar_secondary_color: { type: 'string', description: 'Hex, or "" to clear.' },
        webinar_accent_color:    { type: 'string', description: 'Hex, or "" to clear.' },
        webinar_logo_url:        { type: 'string' },
        webinar_hero_image_url:  { type: 'string' },
        webinar_headshot_url:    { type: 'string' }
      }
    },
    async run(args) {
      const id = jobId(args);
      const { job_id, ...rest } = args;
      if (!Object.keys(rest).length) throw new ToolError('INVALID_ARGUMENT', 'Provide at least one override to set.');
      // Mirror the portal's own coercion (mockup-portal.html:3145):
      //   isNaN(Number(v)) ? v : Number(v)
      // so "40000" is stored as a number while a human form like "1.1M" stays a
      // string, exactly as it would if a rep typed it into edit mode.
      for (const k of ['tam_total', 'recommended_outreach', 'full_market_cycle',
                       'roi_ltv', 'roi_show_rate', 'roi_close_rate']) {
        const v = rest[k];
        if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) rest[k] = Number(v);
      }
      // Fail fast with a clearer message than the server's 400 — these get
      // inlined into onclick attributes in the portal, hence the strict check.
      for (const k of ['webinar_primary_color', 'webinar_secondary_color', 'webinar_accent_color']) {
        const v = rest[k];
        if (v !== undefined && v !== '' && !/^#[0-9a-f]{6}$/i.test(String(v))) {
          throw new ToolError('INVALID_ARGUMENT', `${k} must be a 6-digit hex colour like "#1a2b3c" (or "" to clear), got: ${v}`);
        }
      }
      return fromApi(await callApi('PATCH', `/api/jobs/${id}/overrides`, rest));
    }
  },

  // ── Pipeline actions (spend money / discard output) ────────────────────────
  {
    name: 'start_or_continue_pipeline',
    title: 'Regenerate personalisation stage',
    description:
      'The portal\'s "Regenerate" action. Resets brand_scrape, prospect_research, webinar_titles and calendar_visual ' +
      'to pending so the worker rebuilds them, and clears the stored brand and research data. Leaves extract and ' +
      'lead_list alone. Note there is no per-task rerun in Deal Forge — this is the only stage-restart a rep has. ' +
      'Discards existing output for those four tasks and spends Claude + scraping credits.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: { type: 'object', required: ['job_id', 'confirm'], properties: { job_id: S.jobId, confirm: S.confirm } },
    async run(args) {
      const id = jobId(args);
      needConfirm(args, 'This discards existing brand, research, webinar and calendar output and re-runs them (Claude + scraping spend).');
      return fromApi(await callApi('POST', `/api/jobs/${id}/regenerate`, {}));
    }
  },
  {
    name: 'rerun_apollo',
    title: 'Re-run Apollo lead search',
    description:
      'Re-run the Apollo lead search with the job\'s current ICP filters, refreshing the 25-lead list, TAM and ' +
      'recommended outreach. Requires at least one ICP filter to be set. Returns immediately; progress is stored on ' +
      'the job and survives a restart — poll get_job_status. Spends Apollo enrichment credits.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: { type: 'object', required: ['job_id', 'confirm'], properties: { job_id: S.jobId, confirm: S.confirm } },
    async run(args) {
      const id = jobId(args);
      needConfirm(args, 'This spends Apollo credits and replaces the existing lead list.');
      const r = await callApi('POST', `/api/jobs/${id}/rerun-apollo`, {});
      if (!r.ok) return fromApi(r);
      return okResult({ ...r.data, poll_with: 'get_job_status', progress_field: 'async.apollo_rerun' });
    }
  },
  {
    name: 'rerun_tam',
    title: 'Re-run TAM estimate',
    description:
      'Recompute total addressable market with a chosen method and clear any manual TAM overrides. ' +
      'apollo = exact Apollo count (no AI, no token spend). llm = AI planner grounded in real Apollo probes. ' +
      'llm_pure = AI estimate with no probing. Runs inline and can take 10-20 seconds for the AI methods.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object', required: ['job_id', 'confirm'],
      properties: { job_id: S.jobId, tam_method: { type: 'string', enum: ['apollo', 'llm', 'llm_pure'], default: 'llm' }, confirm: S.confirm }
    },
    async run(args) {
      const id = jobId(args);
      needConfirm(args, 'This clears manual TAM overrides and, for the AI methods, spends Claude tokens.');
      return fromApi(await callApi('POST', `/api/jobs/${id}/rerun-tam`,
        { tam_method: args.tam_method || 'llm' }, { timeoutMs: 60000 }));
    }
  },
  {
    name: 'regenerate_webinar_titles',
    title: 'Regenerate calendar copy',
    description:
      'Re-run the webinar title / calendar copy generator against the current Copy Brain, optionally steered by a ' +
      'custom instruction. Overwrites the three A/B/C variants and resets calendar_visual so it rebuilds. ' +
      'Returns immediately; progress is stored on the job — poll get_job_status. Spends Claude tokens.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object', required: ['job_id', 'confirm'],
      properties: {
        job_id: S.jobId,
        prompt: { type: 'string', description: 'Optional steering instruction, truncated to 800 chars by the server.' },
        confirm: S.confirm
      }
    },
    async run(args) {
      const id = jobId(args);
      needConfirm(args, 'This overwrites the existing calendar copy variants and spends Claude tokens.');
      const r = await callApi('POST', `/api/jobs/${id}/regenerate/webinar-titles`, { prompt: args.prompt || '' });
      if (!r.ok) return fromApi(r);
      return okResult({ ...r.data, poll_with: 'get_job_status', progress_field: 'async.webinar_rerun' });
    }
  },
  {
    name: 'rescan_brand_colors',
    title: 'Re-scrape brand colours',
    description:
      'Re-scrape the prospect website for logo and brand colours, optionally against a corrected URL (which is also ' +
      'saved to the job). Clears any manual colour overrides so the fresh scrape shows through. Runs inline.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object', required: ['job_id', 'confirm'],
      properties: { job_id: S.jobId, website: { type: 'string', description: 'Optional corrected website URL.' }, confirm: S.confirm }
    },
    async run(args) {
      const id = jobId(args);
      needConfirm(args, 'This clears manual brand-colour overrides and re-scrapes the website.');
      const body = args.website ? { website: args.website } : {};
      return fromApi(await callApi('POST', `/api/jobs/${id}/rescan-brand-colors`, body, { timeoutMs: 90000 }));
    }
  },
  {
    name: 'reveal_lead',
    title: 'Reveal a lead',
    description:
      'Enrich one lead from the job\'s lead list with name, work email, company size and website. ' +
      'COSTS EXACTLY ONE APOLLO CREDIT per newly revealed lead. Idempotent: a lead already revealed returns the ' +
      'cached record and spends nothing. Get apollo_id values from get_job with include:["leads"].',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object', required: ['job_id', 'apollo_id', 'confirm'],
      properties: { job_id: S.jobId, apollo_id: { type: 'string', description: 'Apollo person id from the lead list.' }, confirm: S.confirm }
    },
    async run(args) {
      const id = jobId(args);
      needConfirm(args, 'This spends 1 Apollo credit (unless the lead was already revealed).');
      const apolloId = String(args.apollo_id || '').trim();
      if (!apolloId) throw new ToolError('INVALID_ARGUMENT', 'apollo_id is required.');
      return fromApi(await callApi('POST', `/api/jobs/${id}/leads/reveal`, { apollo_id: apolloId }));
    }
  },

  // ── Two-phase intake (optional — create_job usually makes this unnecessary) ─
  {
    name: 'prefetch_prospect',
    title: 'Look up a prospect',
    description:
      'Phase 1 of the manual intake flow: look up a prospect in GoHighLevel, resolve the owning rep, and search ' +
      'Fireflies and Zoom for their Call 1 transcript. Returns contact details, the resolved rep and ranked ' +
      'transcript candidates. Pass prefetch_id to keep polling one already started. ' +
      'May spend an Apollo people/match credit when GoHighLevel data is sparse. ' +
      'NOTE: progress lives in memory on a single instance — it is lost on redeploy and expires after ~10 minutes. ' +
      'You usually do not need this: create_job finds the transcript by email on its own.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      required: ['confirm'],
      properties: {
        email:        { type: 'string', description: 'Prospect email. Required unless polling with prefetch_id.' },
        name:         { type: 'string' }, company: { type: 'string' },
        website:      { type: 'string' }, linkedin_url: { type: 'string' },
        prefetch_id:  { type: 'string', description: 'Continue polling an existing prefetch instead of starting one.' },
        wait_seconds: { type: 'integer', minimum: 5, maximum: 120, default: 45 },
        confirm: S.confirm
      }
    },
    async run(args) {
      needConfirm(args, 'This may spend an Apollo people/match credit.');
      let id = args.prefetch_id;
      if (!id) {
        const email = String(args.email || '').trim();
        if (!email.includes('@')) throw new ToolError('INVALID_ARGUMENT', 'email (or prefetch_id) is required.');
        const start = await callApi('POST', '/api/prefetch', {
          email, name: args.name, company: args.company, website: args.website, linkedin_url: args.linkedin_url
        });
        if (!start.ok) return fromApi(start);
        id = start.data && start.data.prefetch_id;
        if (!id) return failResult('BAD_RESPONSE', 'No prefetch_id returned.');
      }
      const r = await pollProgress('/api/prefetch', id, args.wait_seconds || 45);
      if (!r.ok) return fromApi(r);
      return okResult({ prefetch_id: id, ...r.data });
    }
  },
  {
    name: 'extract_brief',
    title: 'Extract brief from transcript',
    description:
      'Phase 2 of the manual intake flow: scrape the confirmed website and run Claude extraction against a chosen ' +
      'transcript, returning the structured brief for review before you commit it with create_job. ' +
      'Requires a prefetch_id from prefetch_prospect that is still live on this instance. Spends Claude tokens. ' +
      'Pass extract_id to keep polling one already started.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      required: ['confirm'],
      properties: {
        prefetch_id:       { type: 'string', description: 'From prefetch_prospect. Required unless polling with extract_id.' },
        transcript_id:     { type: ['string', 'null'], description: 'Chosen transcript, or null for "no transcript".' },
        transcript_source: { type: 'string', enum: ['fireflies', 'zoom'], default: 'fireflies' },
        website_url:       { type: 'string' },
        extract_id:        { type: 'string', description: 'Continue polling an existing extraction.' },
        wait_seconds:      { type: 'integer', minimum: 5, maximum: 120, default: 60 },
        confirm: S.confirm
      }
    },
    async run(args) {
      needConfirm(args, 'This spends Claude tokens on brief extraction.');
      let id = args.extract_id;
      if (!id) {
        if (!args.prefetch_id) throw new ToolError('INVALID_ARGUMENT', 'prefetch_id (or extract_id) is required.');
        const start = await callApi('POST', '/api/extract-brief', {
          prefetch_id:       args.prefetch_id,
          transcript_id:     args.transcript_id ?? null,
          transcript_source: args.transcript_source || 'fireflies',
          website_url:       args.website_url
        });
        if (!start.ok) return fromApi(start);
        id = start.data && start.data.extract_id;
        if (!id) return failResult('BAD_RESPONSE', 'No extract_id returned.');
      }
      const r = await pollProgress('/api/extract-brief', id, args.wait_seconds || 60);
      if (!r.ok) return fromApi(r);
      return okResult({ extract_id: id, ...r.data });
    }
  },

  // ── Destructive ────────────────────────────────────────────────────────────
  {
    name: 'delete_job',
    title: 'Delete job',
    description:
      'Permanently delete a job and all its tasks. There is no soft delete and no undo. ' +
      'Generated assets remain in storage but become unreachable through the portal. ' +
      'Requires confirm:true AND the server env var DEALFORGE_MCP_ALLOW_DELETE=1.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', required: ['job_id', 'confirm'], properties: { job_id: S.jobId, confirm: S.confirm } },
    async run(args) {
      const id = jobId(args);
      if (!ALLOW_DELETE) {
        throw new ToolError('DELETE_DISABLED',
          'Deletion is disabled on this server. Set DEALFORGE_MCP_ALLOW_DELETE=1 in the Render environment to enable it.');
      }
      needConfirm(args, 'This permanently deletes the job and all its tasks. There is no undo.');
      return fromApi(await callApi('DELETE', `/api/jobs/${id}`));
    }
  }
];

const TOOLS_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

// ── Minimal argument validation ──────────────────────────────────────────────
// Enough to give a useful message instead of a confusing downstream 400.

function validateArgs(tool, args) {
  const schema = tool.inputSchema || {};
  const props  = schema.properties || {};
  for (const req of schema.required || []) {
    if (args[req] === undefined || args[req] === null) {
      if (req === 'confirm') continue;   // needConfirm produces a better message
      throw new ToolError('INVALID_ARGUMENT', `Missing required argument: ${req}`);
    }
  }
  for (const [k, v] of Object.entries(args)) {
    const spec = props[k];
    if (!spec) throw new ToolError('INVALID_ARGUMENT', `Unknown argument: ${k}. Allowed: ${Object.keys(props).join(', ') || '(none)'}`);
    if (v === null || v === undefined) continue;
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    const actual = Array.isArray(v) ? 'array' : typeof v;
    const matches = types.some(t =>
      t === undefined || t === 'null' ||
      (t === 'integer' && actual === 'number' && Number.isInteger(v)) ||
      (t === 'number'  && actual === 'number') ||
      (t === 'array'   && actual === 'array')  ||
      (t === 'object'  && actual === 'object' && !Array.isArray(v)) ||
      t === actual);
    if (!matches) throw new ToolError('INVALID_ARGUMENT', `Argument "${k}" must be ${types.join(' or ')}, got ${actual}.`);
    if (spec.enum && !spec.enum.includes(v)) {
      throw new ToolError('INVALID_ARGUMENT', `Argument "${k}" must be one of: ${spec.enum.join(', ')}. Got: ${v}`);
    }
  }
}

// ── JSON-RPC dispatch ────────────────────────────────────────────────────────

const rpcOk    = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function callTool(name, rawArgs) {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    return { rpcError: [-32602, `Unknown tool: ${name}. Call tools/list for the available tools.`] };
  }
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const started = Date.now();
  try {
    validateArgs(tool, args);
    const result = await tool.run(args);
    audit(name, args, { ok: !result.isError }, Date.now() - started);
    return { result };
  } catch (e) {
    const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR';
    audit(name, args, { ok: false, code }, Date.now() - started);
    if (!(e instanceof ToolError)) console.error(`[mcp] tool ${name} threw:`, e);
    return { result: failResult(code, e.message) };
  }
}

async function dispatch(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid Request');
  }
  const { method, id } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const asked = msg.params && msg.params.protocolVersion;
      // Spec puts the decision on the client: if we don't speak their version,
      // answer with ours rather than erroring.
      const version = PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL;
      return rpcOk(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'deal-forge',
          version: process.env.RENDER_GIT_COMMIT ? String(process.env.RENDER_GIT_COMMIT).slice(0, 7) : 'dev'
        },
        instructions:
          'Deal Forge sales-asset pipeline. Start with list_jobs or get_job. To create a job you usually only need ' +
          'create_job with an email — the pipeline finds the Call 1 transcript and extracts the brief itself. ' +
          'Use get_portal_links to get the prospect-facing link to share with a customer (prospect_url) versus the ' +
          'rep editor link (editor_url). Tools that spend Apollo credits or Claude tokens, or that discard existing ' +
          'output, require confirm:true.'
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return null;
    case 'ping':
      return isNotification ? null : rpcOk(id, {});
    case 'tools/list':
      return rpcOk(id, {
        tools: TOOLS.map(t => ({
          name: t.name, title: t.title, description: t.description,
          inputSchema: t.inputSchema, annotations: t.annotations
        }))
      });
    case 'tools/call': {
      const params = msg.params || {};
      const outcome = await callTool(params.name, params.arguments);
      if (outcome.rpcError) return rpcError(id, outcome.rpcError[0], outcome.rpcError[1]);
      return rpcOk(id, outcome.result);
    }
    // Not declared in capabilities, but sloppy clients probe anyway; empty
    // lists are cheaper than a -32601 they may treat as fatal.
    case 'resources/list':           return rpcOk(id, { resources: [] });
    case 'resources/templates/list': return rpcOk(id, { resourceTemplates: [] });
    case 'prompts/list':             return rpcOk(id, { prompts: [] });
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * @param   {import('http').IncomingMessage} req
 * @param   {import('http').ServerResponse}  res
 * @param   {string} urlPath  request path with the query string already stripped
 * @returns {Promise<boolean>} true iff this module owned and finished the request
 */
async function handle(req, res, urlPath) {
  if (urlPath !== MCP_PATH && urlPath !== MCP_PATH + '/') return false;

  if (req.method === 'OPTIONS') {
    mcpCors(res, req.headers.origin);
    res.writeHead(204); res.end();
    return true;
  }

  // Auth before the body is read, so a rejected request never buffers a payload.
  if (!requireBearer(req, res)) return true;

  if (req.method !== 'POST') {
    // Spec-legal: the server MAY answer 405 to indicate it offers no SSE stream
    // at this endpoint. We are stateless, so there is nothing to stream.
    mcpCors(res, req.headers.origin);
    res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' });
    res.end(JSON.stringify(rpcError(null, -32000, 'Method not allowed. This server is stateless — use POST.')));
    return true;
  }

  let msg;
  try {
    msg = await readJson(req);
  } catch (e) {
    respond(req, res, 400, rpcError(null, -32700, `Parse error: ${e.message}`));
    return true;
  }

  try {
    const batch   = Array.isArray(msg) ? msg : [msg];
    const results = [];
    for (const m of batch) {
      const out = await dispatch(m);
      if (out) results.push(out);
    }
    // All-notification batch: nothing to send back.
    if (!results.length) { respond(req, res, 202, null); return true; }
    respond(req, res, 200, Array.isArray(msg) ? results : results[0]);
  } catch (e) {
    console.error('[mcp] dispatch failed:', e);
    respond(req, res, 500, rpcError(null, -32603, `Internal error: ${e.message}`));
  }
  return true;
}

module.exports = { handle, MCP_PATH, TOOLS };
