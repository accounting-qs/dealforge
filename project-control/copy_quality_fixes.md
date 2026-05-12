# Copy-Generation Quality — Pending Fixes

**Saved:** 2026-05-07
**Scope:** Webinar Titles, Calendar Invitations, Reminder Emails
**Status:** All three are functioning (no crashes, output renders) but have specific quality defects identified by code review.

> **Update 2026-05-12:** The original section 3 ("Webinar Mock + Live Chat") is dropped — the `webinar_mock` task and its standalone HTML asset were removed. The in-portal Webinar Experience tab now renders client-side from existing data. Issues 4.1 / 4.3 below are rewritten accordingly.

---

## Component-by-component findings

### 1. Webinar Titles — `generateWebinarTitles` ([server.js:1600](../server.js))

| # | Issue | Severity |
|---|---|---|
| 1.1 | **Prompt schema mismatch.** System prompt's `format_rules_block` (loaded from [prompts/webinar_titles_fallback_format.txt](../prompts/webinar_titles_fallback_format.txt)) describes a 9-part copy structure (conditional opener, client proof story, contrast frame, YES/MAYBE/unsubscribe block, P.S. replay hook). But the JSON output schema captures only `hook`, `bullets[]`, `for_line`. The rich 9-part copy is lost in JSON serialization. Calendar invite shows a stripped-down hook + bullets. | High |
| 1.2 | **Examples block is empty.** System prompt says "study these examples — match this voice and structure exactly" — but `examples_block` is hardcoded to `'(none loaded)'` (server.js:1625). Sonnet has zero exemplars to anchor voice/style. | High |
| 1.3 | **Principles block is hardcoded** (3-line stub at server.js:1624). Should be richer DR-copywriting reference, ideally DB-overridable. | Medium |
| 1.4 | **No DB prompt override.** Other generators (email_reminder, chat_messages, icp_translation) load from `prompts` table. webinar_titles only loads from file. Reps can't tune voice without code deploys. | Medium |

### 2. Calendar Invite + Reminder Emails — `handleCalendarVisual`, `generateReminderEmails`

| # | Issue | Severity |
|---|---|---|
| 2.1 | **Always uses variant A.** `const variant = titles[0]` (server.js:2409). Portal lets reps switch A/B/C, but the saved calendar HTML is pre-baked with A only. Switching in UI doesn't regenerate downstream. | High |
| 2.2 | **Host name fallback chain ends at company name.** `research_data.host.name \|\| extracted.prospect.name \|\| prospect_company \|\| 'Your Host'` (server.js:2413). If research returns no LinkedIn (common) and contact name is missing, calendar invite shows the **company name as the host** — companies don't host calendars. | High |
| 2.3 | **Generic host bio fallback.** `"${hostName} helps businesses grow through proven webinar strategies."` Useless personalization, identical on every job where research returns null. | Medium |
| 2.4 | **Hardcoded date** (next Tuesday +21 days, 7-8pm, no timezone). Rep cannot override. EU prospects get US-centric time without timezone. | Medium |
| 2.5 | **Reminder email cadence is rigid** (1 week / 24h / 1h before only). No day-of, no mid-week. | Low |

### 3. Cross-cutting

| # | Issue | Severity |
|---|---|---|
| 3.1 | **No regeneration UI** — only fix is re-creating the entire job. | Medium |
| 3.2 | **No fallback logging** when generic strings fire — silent quality degradation. | Low |
| 3.3 | **Variants B and C are dead data downstream.** Calendar only consumes variant A. | Medium |

---

## Implementation plan

### Phase 1 — High-impact correctness (3 edits)

**Edit 1 — Fix variant-A lock-in** (Issues 2.1, 3.3)
- Persist rep's selected variant on `extracted_data._selected_variant: 'A'|'B'|'C'`.
- Calendar handler reads selected variant instead of `titles[0]`.
- Variant switch in portal triggers a small re-render endpoint that regenerates calendar HTML using the new variant. **No new Sonnet calls** — just template re-interpolation with existing variant data.

**Edit 2 — Fix host-name fallback** (Issue 2.2)
- Stop falling back to `prospect_company` for `hostName`. If research and contact name both fail, surface `needs_input` and let the rep enter the host's name in the portal.
- Cleaner: split `hostName` (must be a person) from `hostingCompany` (the prospect's company). Calendar uses both.

**Edit 3 — Add `examples_block`** (Issue 1.2)
- Create `prompts/webinar_titles_examples.txt` with 3-5 high-quality QS-style exemplars.
- Wire through `interpolate(WEBINAR_SYSTEM_TEMPLATE, { examples_block: <loaded> })` instead of `'(none loaded)'`.

### Phase 2 — Copy quality + flexibility (2 edits)

**Edit 4 — Move webinar_titles to DB-overridable** (Issue 1.4)
- `loadPromptFromDB('webinar_titles_system', WEBINAR_SYSTEM_TEMPLATE)` matches existing pattern (email_reminder).

**Edit 5 — Editable event date + timezone** (Issue 2.4)
- `extracted_data._event_date` and `_event_timezone` overrides via `/api/jobs/:id/overrides`.
- Calendar handler reads override first, falls back to "next Tuesday +21 days, 7-8pm UTC".
- Portal: small inline date picker in edit mode.

### Phase 3 — Polish

**Edit 6 — Restructure JSON schema to capture 9-part format** (Issue 1.1)
- Touches the prompt, parser, calendar template, and portal display. Defer until Phase 1+2 are stable.

**Edit 7 — Fallback logging** (Issue 3.2)
- `console.warn` when fallback strings fire — visibility in Render logs.

**Edit 8 — Regeneration endpoint** (Issue 3.1)
- `POST /api/jobs/:id/regenerate?asset=webinar_titles|calendar_visual` — same pattern as `/rerun-apollo`.

---

## Recommended order

1. **Phase 1 first** — highest-impact correctness, near-zero risk.
2. Phase 2 once Phase 1 is stable.
3. Phase 3 only after validating Phase 1+2 quality in production.

Edit 7 (the 9-part JSON schema) is tempting but risky — touching it requires editing the prompt + parser + calendar template + portal display coherently. Hold until Phase 1+2 are validated.
