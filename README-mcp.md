# Deal Forge MCP Server

A remote [MCP](https://modelcontextprotocol.io) server that lets an external agent — Grok, Claude, or any MCP client — do what a rep can do in the Deal Forge UI: create jobs, edit the brief and ICP, use the portal's edit-mode overrides, re-run pipeline stages, and hand out the prospect-facing link.

It runs **inside the existing app** on the existing Render service. No second service, no new dependencies.

---

## Endpoint

```
https://deal-forge-angel.onrender.com/mcp
```

- **Transport:** Streamable HTTP (stateless — no session id is ever issued)
- **Method:** `POST` only. `GET`/`DELETE` return `405`; there is no SSE stream to open.
- **Auth:** `Authorization: Bearer <DEALFORGE_MCP_TOKEN>`
- **Accept:** anything. `application/json`, `text/event-stream`, both, `*/*`, or omitted — the server negotiates and replies in kind.

### Setup

1. Generate a token:
   ```bash
   openssl rand -hex 32
   ```
2. In the **Render dashboard** (not a committed file — repo files are served publicly), set:

   | Variable | Required | Purpose |
   |---|---|---|
   | `DEALFORGE_MCP_TOKEN` | **yes** | Bearer token. Must be ≥32 chars or `/mcp` refuses all traffic with `503`. |
   | `DEALFORGE_MCP_ALLOW_DELETE` | no | Set to `1` to enable `delete_job`. Off by default. |
   | `PUBLIC_BASE_URL` | no | Base for generated portal links. Defaults to `https://deal-forge-angel.onrender.com`. |

3. Redeploy. Verify:
   ```bash
   curl -s -X POST https://deal-forge-angel.onrender.com/mcp \
     -H "Authorization: Bearer $DEALFORGE_MCP_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

**Fail-closed:** if `DEALFORGE_MCP_TOKEN` is unset or too short, `/mcp` returns `503` to *everyone* and logs a warning at boot. A missing env var never means an open endpoint.

### Connecting Grok

```json
{
  "type": "mcp",
  "server_url": "https://deal-forge-angel.onrender.com/mcp",
  "server_label": "dealforge",
  "authorization": "<DEALFORGE_MCP_TOKEN>"
}
```

Add `"allowed_tools": ["list_jobs", "get_job", "create_job", …]` to narrow what a given bot can reach — that works without a redeploy.

> xAI does **not** support MCP's `require_approval`, so there is no human-in-the-loop prompt. Every guardrail here is server-side (see *Confirm gate*).

---

## Tools

### Read

| Tool | What it does |
|---|---|
| `list_jobs` | Recent jobs, newest first. Filter by `status`, `rep`, `query`, `limit`. |
| `get_job` | One job: identity, task statuses, headline TAM/outreach/lead numbers, links. Heavy sections opt-in via `include`. |
| `get_job_status` | Lightweight poll — task statuses plus background rerun progress. Use this in loops, not `get_job`. |
| `get_portal_links` | Every URL for a job, and which are safe to send a prospect. |
| `list_sales_reps` | Rep slugs, names, active flags, job counts. Slugs feed `create_job` / `assign_rep`. |
| `worker_status` | Pipeline worker health. Check first if jobs are stuck in pending. |

### Create and edit — no spend

| Tool | What it does |
|---|---|
| `create_job` | Creates a job and starts the pipeline. **Only `email` is required.** |
| `assign_rep` | Assign or clear the rep (`slug: null` to unassign). |
| `update_brief` | Prospect record + any brief section. Merges; triggers no reruns. |
| `update_icp` | Apollo targeting filters. Saves only — call `rerun_apollo` to re-fetch. |
| `set_overrides` | The portal's **edit mode**: TAM, ROI inputs, calendar copy A/B/C, brand colours, image slots. |

### Confirm-gated — spends money or discards output

All require `confirm: true`.

| Tool | Cost |
|---|---|
| `start_or_continue_pipeline` | Re-runs brand/research/webinar/calendar. Claude + scraping. |
| `rerun_apollo` | Apollo search + enrichment credits. Async. |
| `rerun_tam` | Claude tokens on `llm`/`llm_pure`. Runs inline, 10–20s. |
| `regenerate_webinar_titles` | Claude tokens. Async. Resets `calendar_visual`. |
| `rescan_brand_colors` | Scraping. Clears colour overrides. |
| `reveal_lead` | **Exactly 1 Apollo credit.** Idempotent — an already-revealed lead costs nothing. |
| `prefetch_prospect` | May spend an Apollo people/match credit. |
| `extract_brief` | Claude tokens. |
| `delete_job` | **Unrecoverable.** Also needs `DEALFORGE_MCP_ALLOW_DELETE=1`. |

---

## How to use it

### Creating a job

You almost always only need an email:

```json
{ "name": "create_job", "arguments": { "email": "prospect@example.com" } }
```

The `extract` task searches Fireflies and Zoom for the Call 1 transcript by email and runs Claude extraction itself, so a bare email yields a fully populated job. Anything you pass in `brief` is treated as **rep-confirmed and wins** over what extraction finds; blank fields get filled in.

Then poll:

```json
{ "name": "get_job_status", "arguments": { "job_id": "…" } }
```

`prefetch_prospect` → `extract_brief` → `create_job` exists if you want to review a brief before committing, but it is not the normal path — and its progress lives in memory on one instance, so it is lost on redeploy and expires after ~10 minutes.

### Sharing with a customer

`get_portal_links` returns both:

- `prospect_url` — **send this to the customer**
- `editor_url` — same page with rep-only editing controls. Do not send this to a prospect.

It also returns the ROI calculator in rep and prospect views, the calendar asset, and an `asset_readiness` map so you can check an asset exists before sharing.

### Editing like a rep

`set_overrides` writes the same values the portal's edit mode does. They beat AI-generated values everywhere and survive pipeline reruns. Pass `""` to clear a field back to the AI value.

Numeric fields accept a number or a human form — `40000` and `"1.1M"` both work, matching what a rep can type. This mirrors the portal's own coercion at `mockup-portal.html:3145`.

Common case: `roi_model` finishing as `needs_input` with *"Missing: LTV"* is normal — set `roi_ltv` via `set_overrides`.

---

## Response contract

Every tool returns one of:

```json
{ "ok": true,  "data": { … } }
{ "ok": false, "error": { "code": "…", "message": "…", "http_status": 400 } }
```

Failures also set MCP `isError: true`.

Several app routes answer HTTP 200 with an error in the body (`/api/prefetch/:id`, `/api/extract-brief/:id`, `/api/zoom/test`). Those are normalised to `ok: false` here, so an agent can never read a 200 as success. Bare arrays, `{ok:true,…}` envelopes and raw rows are all flattened into the shape above.

**Size:** a single result is capped at 90 KB and truncated with an explicit marker rather than silently cut. `get_job` is compact by default for this reason — request `include: ["leads"]` etc. only when you need it.

### Confirm gate

```json
{ "ok": false, "error": {
  "code": "CONFIRMATION_REQUIRED",
  "message": "This spends Apollo credits and replaces the existing lead list. Re-call with confirm: true to proceed."
} }
```

No work is done, and nothing is spent, before this is returned.

---

## Architecture

```
Grok ──HTTPS + Bearer──► POST /mcp ──► tool handler ──loopback──► 127.0.0.1:$PORT/api/… ──► Supabase / worker / Apollo / Claude
```

Tools call the app's own HTTP API over loopback rather than invoking internal functions. Route logic lives inline in `server.js`'s if-chain and is not callable as functions; going over loopback guarantees MCP behaviour can never drift from what the dashboard gets — same validation, same side effects — for one sub-millisecond local hop.

### Files

| File | Role |
|---|---|
| `mcp-server.js` | The entire implementation. Exports `handle(req, res, urlPath)`. |
| `server.js` | One `require` + one line in the router, above the blanket `OPTIONS` handler. |

### Why hand-rolled JSON-RPC

`@modelcontextprotocol/sdk` was evaluated and rejected:

- It pulls **87 transitive packages** (express 5, hono, jose, ajv, cors, express-rate-limit, zod) into an app that deliberately runs on three.
- Its Node transport wraps `@hono/node-server`, which reads `req.rawHeaders` rather than `req.headers` — so the usual `req.headers.accept = …` interop fix is a **silent no-op**, and the transport hard-`406`s any client not sending both `application/json` and `text/event-stream`, with no way to disable it (`webStandardStreamableHttp.js:471`).

A client only ever needs five methods here: `initialize`, `notifications/*`, `ping`, `tools/list`, `tools/call`. We own those and content-negotiate instead of fighting a transitive dependency's internals.

**Escape hatch:** the only export is `handle(req, res, urlPath)`. Swap the internals for the SDK and `server.js` does not change. Do that if you ever need server-initiated messages (sampling, elicitation) or real OAuth.

### Stateless

No `Mcp-Session-Id` is issued. Render overlaps instances during a deploy, so a session pinned to one instance would 404 mid-conversation with no recovery path for an agent. A session id sent by a client is ignored, not rejected.

---

## Local development

```bash
DISABLE_WORKER=1 PORT=3111 DEALFORGE_MCP_TOKEN=testtoken_0123456789abcdef0123456789abcdef node server.js
```

`DISABLE_WORKER=1` matters: `.env` points at the **shared production Supabase**, so without it a local instance competes with the real worker for tasks.

```bash
T=testtoken_0123456789abcdef0123456789abcdef
U=http://127.0.0.1:3111/mcp

# handshake
curl -s -X POST $U -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'

# tools
curl -s -X POST $U -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# a call
curl -s -X POST $U -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_jobs","arguments":{"limit":2}}}'
```

Browser-based debugging works too — `npx @modelcontextprotocol/inspector`, Streamable HTTP, with the bearer header. The CORS headers on `/mcp` are set up for it. Don't add it as a dependency.

### Logging

One audit line per tool call. Argument **keys** only — values carry prospect PII, and the token is never logged.

```
[mcp] tool=set_overrides job=fcb102d4-… args=job_id,tam_total confirm=false ok=true ms=412
```

---

## Known limits

- **The rest of `/api/*` has no authentication.** Bearer auth on `/mcp` is real, but anyone with the URL can already create or delete jobs directly. The MCP token is not the weakest link — locking down `/api/*` is separate work needing a login step in the dashboard and portal.
- **Binary upload is not exposed.** `POST /api/jobs/:id/upload-asset` takes a raw image body, which doesn't fit JSON tool arguments. Point `set_overrides` at an existing image URL instead.
- **Not exposed:** copy-brain CRUD, prompt editing, Zoom/SOP config, rep creation, calls and notifications. All are thin additions if wanted. Prompt editing is deliberately excluded — it would let an agent rewrite the production Claude prompts that drive its own pipeline.
- **There is no per-task rerun** in Deal Forge for anyone. `start_or_continue_pipeline` maps to the portal's "Regenerate" button, which resets `brand_scrape`, `prospect_research`, `webinar_titles` and `calendar_visual` only.
