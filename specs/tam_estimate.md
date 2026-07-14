# Task Spec: tam_estimate

**Pipeline stage:** 2 — parallel with `brand_scrape`, `lead_list`, `webinar_titles`, `roi_model`
**Depends on:** `extract` completed (`jobs.extracted_data.icp` populated)
**Blocks:** Nothing downstream
**Model:** Claude `claude-sonnet-4-6` (query-planner call) + Apollo `mixed_people/api_search` (count-only probes)
**Temperature:** 0
**Max tokens:** ~1500
**Status:** FULLY SPECCED

---

## 1. What This Task Does

Produces the **headline Total Addressable Market (TAM) number** shown at the top of the Lead List tab — **decoupled from the narrow Apollo lead search** that produces the 25 sample leads.

**Why this task exists.** Today the TAM is Apollo's `total_entries` for the exact ICP lead-search payload (`handleLeadList`, `server.js:4659`). Because that payload uses one narrow set of titles, the count under-represents the real market by ~10–20× and causes reps to wrongly disqualify prospects. The 25 leads *should* stay narrow (they must be the sharp, best-fit sample), but the TAM *should* reflect the broad addressable market.

**Approach — LLM-broadened Apollo (grounded, not fabricated).** Claude reads the ICP brief and generates several *broad but valid* Apollo search "slices" (e.g. seniority + department instead of one exact title; adjacent decision-maker roles; geography/size kept wide). We run each slice as a **count-only** Apollo probe (`per_page: 1` → read `total_entries`) and derive the TAM from **real Apollo counts** — never a number Claude invents. This directly fixes the under-count while keeping the number defensible: every figure traces to an Apollo query.

**What this task does NOT do:** it does not fetch or rank leads (that stays in `lead_list`), and it does not read/modify the ROI model math. It only computes the market-size figure + the recommended monthly outreach derived from it.

---

## 2. Inputs

Read from `jobs.extracted_data.icp` (produced by `extract`):

| Field | Source | Required | Notes |
|-------|--------|----------|-------|
| `icp.target_audience_type` | extracted_data | Required | `'b2c'` → `needs_input` (Apollo is B2B-only; mirrors `handleLeadList` B2C short-circuit at `server.js:4623`) |
| `icp.apollo_titles` | extracted_data | Required-ish | 3–6 titles; if null AND no usable role signal → `needs_input` |
| `icp.apollo_keyword` / `icp.industry` | extracted_data | Optional | industry phrase for `q_organization_keyword_tags` (OR semantics) |
| `icp.apollo_employee_ranges` | extracted_data | Optional | Apollo range codes (`'51,200'` etc.); omitted if empty |
| `icp.apollo_geography` | extracted_data | Optional | country/region names; EU chips expanded via `expandEU` |
| `icp.person_seniorities` | extracted_data | Optional | usually null from extract; rep may add. Valid values: `owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern` |
| `icp.apollo_revenue_range` | extracted_data | Optional | `{min,max}` USD |

**No new discovery capture is added by this task.** Alex's 5 broad discovery questions feed the *existing* `extract` ICP fields via the Call-1 script; exclusions are not a first-class ICP field and are handled only if present in the brief text. (Dependency to flag to Alex/Lloyd: TAM quality rides on reps asking the broader questions on Call 1.)

---

## 3. Null / Missing Field Handling

- `target_audience_type === 'b2c'` → `needsInputTask(task.id, 'TAM estimate skipped — B2C audience (Apollo is B2B-only)')`, `return null`.
- `apollo_titles` empty AND `icp.role` empty AND `person_seniorities` empty → `needsInputTask(task.id, 'Missing ICP titles/roles — cannot estimate TAM')`, `return null`.
- Apollo API key missing (`process.env.APOLLO_API_KEY`) → task `failed` with `'APOLLO_API_KEY not set'` (deployment error, not runtime).
- Claude call fails after retries → **graceful degradation:** fall back to a single broad slice built deterministically from the ICP (titles OR + geo + size, industry dropped), probe it, and return that count with `tam_source: 'apollo_broad_fallback'` and `confidence: null`. The task still completes so the portal has a number. (The portal separately falls back to the `lead_list` Apollo total if this task is absent/failed — see §7.)

---

## 4. Processing Logic

1. Read `icp` from `job.extracted_data`. Run the §3 gates.
2. **Claude query-planner call** (`makeAnthropic()` + `claudeMessage`, model `claude-sonnet-4-6`, temp 0). System+user prompt (adapted from Alex's validated ChatGPT "TAM PROMT"): given the ICP, return **4–6 broad, valid Apollo slice payloads** that widen the market a single narrow-title query misses. **Two levers proven decisive in testing** (REACHUM L&D ICP: 1,378 → 88,927, 64.5×): (a) **drop the industry keyword** on the broad slices — `q_organization_keyword_tags` is the single biggest under-counter (1,378 with `pharmaceuticals` → 31,131 without); at least one broad slice must carry no industry keyword. (b) **use valid Apollo department slugs** — `person_department_or_subdepartments` needs exact snake_case (`human_resources`, not "learning and development", which silently returns 0). `normalizeDepartments()` maps common phrases to slugs and drops the rest. Each slice:
   - uses only these Apollo fields: `person_titles`, `person_seniorities`, `person_department_or_subdepartments`, `organization_locations`, `organization_num_employees_ranges`, `q_organization_keyword_tags`, `revenue_range`;
   - has a short human `label` (e.g. "Seniority + department (broad)", "Adjacent decision-makers", "Exact titles (narrow floor)");
   - is designed to be broad-but-believable (prefer seniority+department over one exact title; keep geo/size wide; drop over-narrow industry AND-filters).
   - Also return: `confidence` (1–10), `reasoning` (1 sentence), and an optional `union_uplift` (a small multiplier ≥1.0, ≤1.5, applied to the largest slice to approximate cross-slice union, **with a one-line justification**).
   Parse with `extractJsonObject` (never throws). If the parse yields no slices → degrade per §3.
3. **Sanitize + guard + probe each slice.** Normalize departments via `normalizeDepartments()`; run every slice payload through `sanitizeApolloPayload()`; **drop unbounded slices** — any slice with `person_seniorities` but NO `person_titles` and NO valid department is rejected (seniority-only matches millions, e.g. "all VPs" = ~3.9M, and would blow up the TAM). Then probe each via `apolloCountForPayload(payload)` → `POST /api/v1/mixed_people/api_search` with `per_page: 1`, return `total_entries`. Reuse `expandEU` for geography. Each failure → that slice count = 0 (best-effort, logged).
4. **Grounded aggregation:**
   - `tam_floor` = the narrow "exact titles" slice count (≈ today's number), for the credibility subline.
   - `largest` = max slice `total_entries` (Apollo dedups **within** a single query, so this is a real deduped count — never sum slices, which double-counts overlaps).
   - `tam_total` = `round(largest × clamp(union_uplift, 1.0, 1.5))`. If `union_uplift` absent → `largest`.
   - Guard: if all slices returned 0 → degrade to `apollo_broad_fallback` (§3) or, if that is also 0, `tam_total = tam_floor` (may be 0; portal shows Apollo total instead).
5. `recommendedOutreach = computeRecommendedOutreach(tam_total)` — the shared helper (see §5 note). Same "rep-proof" formula used everywhere: `tam>300k → 100k`; else `tam>0 → max(1000, round(tam/3/1000)*1000)`; else `30000`.
6. Return the output object (§5). Worker `completeTask` writes it to `tasks.output_data`.

**Formula centralization:** the outreach formula currently duplicated at `server.js:4663`, `server.js:7055`, and `mockup-portal.html:3725` is extracted into `computeRecommendedOutreach(tam)` and reused by this task, the rerun path, and the portal.

---

## 5. Output Schema

Written to `tasks.output_data` (JSONB on tasks table):

```json
{
  "tam_total": 118000,
  "tam_floor": 9200,
  "recommendedOutreach": 39000,
  "tam_source": "llm_broadened_apollo",
  "confidence": 7,
  "reasoning": "Broadening from exact CMO titles to marketing C-suite+VP across the same geos captures the real buyer pool.",
  "union_uplift": 1.15,
  "slices": [
    { "label": "Exact titles (narrow floor)", "total": 9200,   "payload_summary": "person_titles:[CMO,VP Marketing] · US · 51-500" },
    { "label": "Seniority + department (broad)", "total": 102000, "payload_summary": "seniorities:[c_suite,vp] · dept:marketing · US · 51-500" },
    { "label": "Adjacent decision-makers", "total": 61000, "payload_summary": "person_titles:[Head of Growth,Demand Gen Lead] · US · 51-500" }
  ]
}
```

Field names chosen to match the existing portal/override contract: the portal reads `tam_total` and `recommendedOutreach` (same keys as `_generated`), so no portal-side renaming is needed beyond adding this task to the read precedence.

---

## 6. Output Validation

| Check | Behavior |
|-------|----------|
| `tam_total` not a positive finite number | fall back to `tam_floor`, then to null (portal uses `lead_list.output.total`) |
| `slices` empty after probing | degrade to `apollo_broad_fallback` (§3) |
| `confidence` out of 1–10 | clamp; if unparseable set null |
| `union_uplift` < 1 or > 1.5 or non-numeric | clamp to [1.0, 1.5]; treat missing as 1.0 |
| `tam_total < tam_floor` | set `tam_total = tam_floor` (broadening must never shrink the number) |

---

## 7. State Machine Transitions & Portal Contract

- `pending → processing → completed` (normal) / `needs_input` (B2C or no titles) / `failed` (no Apollo key).
- Terminal statuses match `isTerminal` (`server.js:4845`) so job roll-up is unaffected.
- **Portal read precedence** (updated in `buildCompatSession`, `mockup-portal.html:2832`): `_overrides.tam_total > _generated.tam_total > tam_estimate.output.tam_total > lead_list.output.total`. Likewise `recommendedOutreach`. `tam_source` drives the existing "⚠ Estimated" badge (`mockup-portal.html:3698`) whenever it is `llm_broadened_apollo` / `apollo_broad_fallback`. `tam_floor` may render as a small "verified in Apollo: N" subline.
- **Safety fallback:** if this task is absent, failed, or `needs_input`, the portal keeps showing today's Apollo number (`lead_list.output.total`). So shipping this task cannot regress a job below current behavior.

---

## 8. Error Handling

| Scenario | Behavior |
|----------|----------|
| B2C audience | `needs_input`, portal falls back to Apollo total |
| No titles/roles | `needs_input` |
| Claude call fails | graceful degrade to deterministic broad slice (`apollo_broad_fallback`) |
| One Apollo probe fails | that slice = 0, continue (best-effort) |
| All Apollo probes fail / 0 | `tam_total = tam_floor` (or null → portal uses lead_list total) |
| Apollo key missing | `failed` (deployment error) |

No scenario throws unhandled; the job always completes.

---

## 9. Schema Change Required

**One additive migration** (run `/schema-review` first). The live `sales_assets.tasks` table has:
`CHECK (task_type = ANY (ARRAY['extract','prospect_research','brand_scrape','lead_list','webinar_titles','roi_model','calendar_visual','webinar_mock']))`.

Add `'tam_estimate'` to that array:
```sql
ALTER TABLE sales_assets.tasks DROP CONSTRAINT tasks_task_type_check;
ALTER TABLE sales_assets.tasks ADD CONSTRAINT tasks_task_type_check
  CHECK (task_type = ANY (ARRAY['extract','prospect_research','brand_scrape','lead_list',
    'webinar_titles','roi_model','calendar_visual','webinar_mock','tam_estimate']));
```
Additive + reversible; touches no existing rows. `tasks_status_check` already includes `needs_input`/`skipped` — no status change needed.

---

## 10. Idempotency

- Same job → re-running `tam_estimate` overwrites `tasks.output_data` (unique `(job_id, task_type)`; `createTasks` uses `resolution=ignore-duplicates`). Safe to retry.
- Rep `_overrides.tam_total` always wins over regenerated values, so a re-run never clobbers a manual rep edit.
- Cost is idempotent-cheap: 1 Claude call + 3–5 `per_page:1` Apollo probes per run.

---

## 11. Cost Estimate

- Claude planner: ~800 input + ~500 output tokens ≈ **$0.01/job**.
- Apollo probes: 3–5 `mixed_people/api_search` count calls at `per_page:1`. Count-only reads; negligible vs. the enrichment credits `lead_list` already spends.
- Net added cost ≈ **$0.01–0.02/job**. Well within the existing ~$0.05–0.08/job budget.

---

## 12. What's Not in v1

- No structured `exclusions` ICP field (handled only if present in brief text).
- No cross-slice true set-dedup (Apollo returns counts, not ID sets); approximated via `union_uplift ≤ 1.5`.
- No separate "Re-estimate TAM" button UI beyond wiring into the existing Re-run control (can be added later).
- No persistence of slice payloads to `_generated` (kept in `tasks.output_data` only).

**Status:** FULLY SPECCED
