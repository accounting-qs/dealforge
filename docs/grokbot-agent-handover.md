# Handover: Deal Forge changes for the Grokbot Deal Forge agent

From Gergo (Deal Forge developer), October 2026. Give this to the agent that runs or configures Grokbot's Deal Forge work.

**Live status.** These changes are built and tested but **not deployed yet**. That includes the slide fix: as of Oct 13 the live app still runs commit `f4eaa54`. Until Gergo pushes, `tools/list` on the Deal Forge MCP server won't show `get_progress`, `get_editable_fields`, `edit_fields`, `set_case_studies` or `tweak_webinar_deck`. Check for them before relying on this.

---

## 1. What the closers asked for

Sources: Sales Team Training notes (Lloyd and Alex) and the Ryan/Alex prep call on Oct 6.

1. **Briefs must never come out half blank.** If a topic wasn't discussed, it should say so: "the closer didn't talk about it". A brief made through Grokbot must be as good as one made by hand in Deal Forge.
2. **No Quantum Scaling copy in the prospect's assets.** Deal Forge sometimes put QS's own webinar pitch where the prospect's details should be.
3. **Grokbot edits Deal Forge directly. No more copy-paste.** Closers were asking Grokbot for "the fields to paste into Deal Forge" and pasting them by hand. Grokbot should be able to change anything a rep can change: TAM, invite copy, titles, webinar content and so on.
4. **Case studies the closer controls.** Pick from the full list, remove the automatic picks, and the choice stays saved.
5. **Slides must stay put while presenting.** They were jumping back to the title slide.
6. **Grokbot must be faster.** It took 5–10 minutes to create or edit a Deal Forge.
7. **Grokbot must use fewer tokens.** The team keeps running out of credits.
8. **Invite titles must be fresh.** Titles got stuck on an old one.
9. **Grokbot must create the V2 version** (the nine-slide deck closers present). It could only create V1.
10. **Keep the closer posted.** While a Deal Forge is being built or changed, Grokbot should tell the rep where the process is and how much longer it will take, instead of going quiet for minutes.

## 2. What changed in Deal Forge, and what it means for you

| # | Change | What you do differently |
|---|---|---|
| 1 | The pipeline now reads the full transcript, speaker-labelled, when it extracts a brief. If you pass `transcript_id` to `create_job`, it uses exactly that call. Empty fields are listed in `not_discussed`. | Always create jobs with the Call 1 `transcript_id`. Report an empty field as "the closer didn't talk about this on the call". Never fill it with your own guess. |
| 2 | QS's own defaults and sample copy are gone from prospect-facing output. | Never write Quantum Scaling's pitch (webinar acquisition, predictable pipeline, 1,400+ clients, $500M+) into a prospect's fields. |
| 3 | New: `get_editable_fields` (read everything a rep can change) and `edit_fields` (change any of it in one call). | Use these for every edit. |
| 4 | New: `set_case_studies`. `list_case_studies` now returns each client's `id`. "none" stays none; automatic picks don't come back. | Use `set_case_studies` for case studies. |
| 5 | The portal no longer redraws the deck while a job is still generating. | Nothing. |
| 6–7 | Edits are one call and finish in under a second. Responses can be small (`sections`). | Follow the speed and token rules in section 5. |
| 8 | The webinar headline title now actually shows (it used to be saved and ignored). Regenerating clears old title edits. The shareable calendar page updates when a title changes. | Use `webinar.title` for the webinar's title. After a regenerate, re-apply any title the closer wants to keep. |
| 9 | `create_job` takes `portal_version`. `edit_fields job.portal_version` switches an existing job. | Create closer jobs with `portal_version: "v2"`. |
| 10 | New: `get_progress`. It returns a ready-to-send sentence for the rep, the time left, the percent done, each step's status, and anything that failed or is stuck. | After starting anything that takes time, send the rep `message_for_rep` and keep them updated (section 4, "Keep the closer posted"). |

---

## 3. Tools

Response shape: `{ "ok": true, "data": … }` or `{ "ok": false, "error": { "code", "message" } }`.

### Read
- **`get_editable_fields { job_id, sections? }`** is the main read. It returns every rep-editable field, its current value and the **write path** for it.
  - `sections` can be any of: `job`, `prospect`, `brief`, `not_discussed`, `headline_title`, `invite`, `deck`, `numbers`, `figures`, `proof`, `brand`, `case_studies`, `override_meanings`.
  - Ask only for what you need. `["invite"]` is about 2 KB; the full read is about 11 KB.
- **`get_job { job_id, include? }`** returns identity, task status, headline numbers and links.
  - `include: ["brief"]` adds `not_discussed`. `include: ["deck"]` returns the nine slides.
  - Avoid `include: ["leads"]` unless you need the leads; it's large.
- **`get_progress { job_id }`** tells you where a job is and how long is left. Use it after `create_job`, `start_or_continue_pipeline`, `regenerate_webinar_titles` and `rerun_apollo`. It returns:
  - `message_for_rep`: one plain sentence you can send as-is. While running, it reads like "Acme Supply Chain: Writing the invite copy. 4 of 8 steps done, about 3 min left." When done: "Acme Supply Chain is ready. Prospect link: …". If something needs attention, it names it ("ROI model needs input: Missing: LTV").
  - `state`: `running`, `done` or `done_with_issues`.
  - `percent`, `eta_seconds` and `eta_text` (e.g. "about 3 min"), `steps_done` / `steps_total`.
  - `current`: what is happening right now.
  - `steps`: each step's status (`done`, `running`, `queued`, `waiting`, `failed`, `needs_input`, `skipped`), with `seconds_left` for unfinished ones.
  - `attention`: anything failed, stuck, needing input, or a rerun that stopped reporting.
  - `jobs_ahead_in_queue`: Deal Forge builds one step at a time across all jobs, so other jobs can be ahead.
  - `next_check_in_seconds`: wait this long before you check again (20–60 s; `null` when done).
  - The time left comes from how long each step really took on recent jobs, plus the queue ahead. It is an estimate; say "about".
- **`get_portal_links`** returns the links. **`get_job_status`** gives raw task statuses, for debugging only.
- **`list_case_studies { tab?, job_id?, include_below_floor? }`** returns QS client examples with their `id`.

### Write (no spend, no reruns)
**`edit_fields { job_id, changes: { "<path>": value, … } }`** changes any number of fields in one call.

| Path | What it changes |
|---|---|
| `webinar.title` | The webinar's headline title (invite + slide 1), unless a variant has its own |
| `invite.a.title` / `invite.b.title` / `invite.c.title` | One invite variant's title |
| `invite.a.description` (b, c) | One invite variant's description (HTML allowed; scripts are stripped) |
| `deck.1.headline` … `deck.9.headline`, `deck.N.sub` | One deck slide |
| `override.tam_total` | Headline TAM. Accepts `1200000` or `"1.2M"` |
| `override.recommended_outreach` | Invites per month |
| `override.roi_ltv` | **Year-one** revenue per new client in dollars (not lifetime value) |
| `override.roi_show_rate` | % of **booked** calls that are attended (0–100) |
| `override.roi_close_rate` | % of **held** calls that become clients (0–100). This is NOT the attendee-to-booking rate |
| `override.fig_*` | A number on a deck chart (e.g. `fig_funnel_clients`) |
| `override.proof_client` / `proof_result` / `proof_before` / `proof_after` | The Proof slide, which is hidden until client + result are set. Must be one of the **prospect's** clients, never a QS client |
| `override.webinar_primary_color` (secondary, accent) | `"#1a2b3c"` |
| `override.webinar_logo_url` / `webinar_hero_image_url` / `webinar_headshot_url` | An image URL |
| `brief.<section>.<field>` | Any brief field. Sections: `prospect`, `icp`, `metrics`, `angle`, `verbatim`, `situation`, `context`, `titles`, `webinar` |
| `icp.apollo_titles`, `icp.apollo_keyword`, `icp.apollo_geography`, `icp.apollo_employee_ranges`, `icp.apollo_person_locations`, `icp.apollo_revenue_range`, `icp.person_seniorities`, `icp.target_audience_type` | Apollo targeting. Then call `rerun_apollo` |
| `prospect.email` / `name` / `company` / `website` / `linkedin_url` | The prospect record |
| `job.portal_version` | `"v1"` or `"v2"` |
| `job.rep` | Rep slug from `list_sales_reps`, or `null` |
| `job.tam_method` | `"apollo"`, `"llm"` or `"llm_pure"`. Then call `rerun_tam` |
| `case_studies.<lead_list\|invite\|webinar\|roi>` | `["rec…", …]`, `"none"` or `"auto"` |
| `case_studies.invite.opens_on` / `case_studies.webinar.opens_on` | `"yours"` or a chosen id |

- Sending `""` or `null` clears an override back to the AI value.
- The response has four parts:
  - `applied`: what was written.
  - `rejected`: each failed path with the reason. Unknown path, bad colour, non-numeric ROI, or unfinished copy such as `[client name]` or TBD.
  - `before`: previous values, for undo.
  - `next`: what to run if the change needs it, e.g. `rerun_apollo` after an Apollo filter change.
- `get_editable_fields` → `override_meanings` explains every override key. Read it before writing a number you aren't sure about.

**`set_case_studies { job_id, surface, choose, opens_on? }`** picks client examples for a tab.
- `surface`: `lead_list`, `invite`, `webinar` or `roi`.
- `choose`: ids from `list_case_studies` (shown in that order), `"none"`, or `"auto"`.
- `opens_on` applies to invite and webinar only.

### Spends money or discards output (`confirm: true` required)
- **`tweak_webinar_deck { job_id, instruction, slide?, confirm }`** is the portal's "Tweak the slides" box, and spends Claude tokens.
  - It refuses to invent statistics, clients or results.
  - For exact wording you already have, use `edit_fields deck.N.headline` instead; it's faster and free.
- **`regenerate_webinar_titles { job_id, prompt?, confirm }`** writes new invite copy. It takes about a minute or two and runs in the background; keep the rep posted with `get_progress`.
  - It **clears** invite title and description edits and returns them in `cleared_overrides`.
- **`create_job`, `start_or_continue_pipeline`, `rerun_apollo`, `rerun_tam`, `rescan_brand_colors`, `reveal_lead`, `prefetch_prospect`, `extract_brief`, `delete_job`** are unchanged, except that `create_job` now takes `portal_version`.

---

## 4. Playbooks

**Create a Deal Forge for a prospect**
1. `prefetch_prospect { email, confirm: true }`. Pick the Business Evaluation / Call 1 transcript and note the rep it resolved.
2. `create_job { email, transcript_id, transcript_source, rep_name, portal_version: "v2" }`
3. Call `get_progress` straight away and send the rep its `message_for_rep`, so they know the time to expect from the start. Then follow "Keep the closer posted" below until `state` is `done` or `done_with_issues`.
4. `get_portal_links`. Send `prospect_url` to the customer. `editor_url` is for the closer only; never send it to a prospect.

**Keep the closer posted** (any time something runs in the background)
1. Right after you start it, call `get_progress` and send `message_for_rep`. Example: "Acme Supply Chain: Reading the call transcript. 0 of 8 steps done, about 6 min left."
2. Wait `next_check_in_seconds`, then call `get_progress` again. Don't check faster: every check costs tokens, and it doesn't make Deal Forge faster.
3. Message the rep only when something changes:
   - a new step starts;
   - about every 2 minutes on a long wait;
   - `attention` gets a new entry (say it straight away and say what you'll do about it).
   Don't repeat an identical update.
4. When `state` is `done`, send the final message with the prospect link.
5. When `state` is `done_with_issues`, say what needs a look. Offer the fix (e.g. "ROI model needs input: Missing: LTV" → offer to set `override.roi_ltv`).
6. If a step is flagged as taking much longer than usual, tell the rep, keep checking, and suggest `worker_status` to whoever looks after Deal Forge.
7. Edits made with `edit_fields` and `set_case_studies` are instant. Confirm them right away; they need no progress checks.

**How long things take** (tell the rep up front)
- **An edit** (titles, TAM, slides, brief fields, case studies): instant.
- **Rewriting the invite copy** (`regenerate_webinar_titles`) or **re-running the lead search** (`rerun_apollo`): about one to two minutes.
- **A new Deal Forge, or "Regenerate" on the whole job**: a few minutes. Deal Forge builds one step at a time across all jobs, so it is longer when other jobs are queued. `get_progress` shows how many are ahead.

**"Change the invite title to X" / "make the webinar title X"**
- One `edit_fields` call: `{"webinar.title": "X"}`. Use `{"invite.b.title": "X"}` for a single variant.

**"Set TAM to 1.2M and close rate to 25%"**
- `edit_fields {"override.tam_total": "1.2M", "override.roi_close_rate": 25}`

**"Show only these case studies"**
- `list_case_studies { tab: "Calendar Invite" }`, then `set_case_studies { surface: "invite", choose: [ids], opens_on: id }`.

**"The brief is wrong / missing X"**
- `get_editable_fields { sections: ["brief", "not_discussed"] }`, then `edit_fields { "brief.angle.pain": "…" }`.
- If invite copy should follow, run `regenerate_webinar_titles`. Copy isn't rewritten automatically.

**"Target different titles"**
- `edit_fields { "icp.apollo_titles": [...] }`, then `rerun_apollo { confirm: true }`. This spends Apollo credits; tell the closer.

---

## 5. Rules

- **Batch.** Put every change in one `edit_fields` call, not one call per field.
- **Read narrowly.** Use `get_editable_fields` with `sections` rather than `get_job` with big `include`s.
- **Check progress at the pace `get_progress` sets** (`next_check_in_seconds`, 20–60 s). A regenerate takes a minute or two however often you ask.
- **Compact your memory.** After a tool result is used, keep only the job id, what changed and the links. Use a fresh conversation per prospect.
- **Never invent** statistics, client names, case studies or results. If the closer didn't say it and it isn't in Deal Forge, say so.
- **Respect "not discussed".** Report it as "the closer didn't talk about this on the call". Don't fill it with Quantum Scaling's pitch.
- **Say when something costs money.** Before any `confirm: true` tool, tell the closer it spends Apollo credits or Claude tokens.
- **Say what you did.** After an edit, report what was applied, anything rejected and why, and any `next` step.
- **Don't go quiet.** When something takes longer than a few seconds, the rep hears from you first: what started and roughly how long it will take.

### Connector settings (for whoever configures Grokbot)
- **Server:** `https://deal-forge-angel.onrender.com/mcp`, with the bearer token from Deal Forge → Settings → Integrations.
- **Suggested `allowed_tools`:** `list_jobs`, `get_job`, `get_progress`, `get_portal_links`, `list_sales_reps`, `list_case_studies`, `get_editable_fields`, `edit_fields`, `set_case_studies`, `tweak_webinar_deck`, `create_job`, `prefetch_prospect`, `extract_brief`, `regenerate_webinar_titles`, `start_or_continue_pipeline`, `rerun_apollo`, `rerun_tam`, `rescan_brand_colors`, `reveal_lead`.
  - This drops `set_overrides`, `update_brief`, `update_icp` and `assign_rep`, which `edit_fields` replaces; `get_job_status`, which `get_progress` replaces; and `worker_status` and `delete_job`.
  - It saves roughly 3–4k tokens on every step.
- **Prompt caching:** keep the system prompt and tool list identical at the start of every request so it caches. Put anything per-request after them.
