# Task Spec: webinar_titles

**Pipeline stage:** 2 — Copy Generation
**Depends on:** `extract` (completed, `jobs.extracted_data` populated)
**Model:** Claude Sonnet (claude-sonnet-4-5 or latest Sonnet)
**Temperature:** 0.7
**Max tokens:** 2000
**Status:** SIGNED OFF

---

## 1. What This Task Does

Generates 3 variants of a webinar calendar blocker (title + description) for the prospect's specific webinar offer. Each variant uses a different direct-response copywriting style (Curiosity, Outcome, Mechanism). The output is what Quantum Scaling reps hand off to the prospect as ready-to-use calendar invite copy for their webinar promotion.

This is a persona-swapped port of the CompeteIQ calendar_event generation engine. In CompeteIQ, QS writes for itself. Here, QS writes for the prospect's business, targeting the prospect's ICP.

---

## 2. Inputs

All inputs come from `jobs.extracted_data` (populated by the `extract` task).

### 2.1 Required Fields (null → `needs_input` status)

| Field | Source | Purpose |
|-------|--------|---------|
| `icp.industry` | extracted_data | Who the webinar targets |
| `icp.role` | extracted_data | Job title / decision-maker type |
| `icp.company_size` | extracted_data | Sizing qualifier in copy |
| `customer_pain` | extracted_data | Core pain the webinar addresses |
| `result_delivered` | extracted_data | Outcome the prospect delivers to clients |

### 2.2 Optional Fields (improve quality, not required)

| Field | Source | Fallback if null |
|-------|--------|-----------------|
| `icp.geography` | extracted_data | Omit geographic qualifier from copy |
| `case_study.client_description` | extracted_data | Use segment-agnostic framing |
| `case_study.result` | extracted_data | Skip social proof section |
| `case_study.numbers` | extracted_data | Skip specific proof numbers |
| `webinar_angle` | extracted_data | Use mechanism-based angle from extracted topic |
| `prospect_company_name` | jobs table | Use "your firm" as fallback |
| `prospect_first_name` | jobs table | Skip personalized greeting |

### 2.3 Format Rules (runtime-loaded)

Format rules are NOT hardcoded in this spec or in the prompt file. They are loaded at task execution time from:

- **Source:** CompeteIQ Supabase (`format_brains` table)
- **Query:** `WHERE format_key = 'calendar_event' AND is_active = true`
- **Fields used:** `brain_content` (9-part description structure, injected into system prompt), `example_outputs` (up to 3 few-shot examples)
- **Connection:** `COMPETEIQ_DB_URL` env var in Deal Forge
- **Fallback:** If CompeteIQ DB is unreachable, use embedded fallback rules from `prompts/webinar_titles_fallback_format.txt` — task proceeds with degraded (non-personalized format) rather than failing

---

## 3. Null / Missing Field Handling

If any required field from Section 2.1 is null after `extract` completes:

1. Set `tasks.status = 'needs_input'` (new enum value — see Section 9)
2. Set `tasks.error_message` to list which fields are missing (e.g., `"Missing: icp.industry, customer_pain"`)
3. Do NOT mark the task failed
4. Dashboard displays an input form for the rep to manually enter the missing values
5. When rep submits the form, system writes values back to `jobs.extracted_data`, sets task status back to `pending`, and re-queues for execution

Optional fields that are null are silently skipped — no `needs_input` trigger, no UI form.

---

## 4. Prompt Architecture

### 4.1 System Prompt Structure (mirrors CompeteIQ generation.py `_build_system_prompt`)

```
You are a direct-response copywriter working on behalf of Quantum Scaling (QS),
a B2B growth agency. You are writing calendar blocker copy for [prospect_company_name]'s
webinar — targeting [icp.role]s in the [icp.industry] industry.

Your job is to write LinkedIn/Google calendar invites that get [icp.role]s to click
YES or MAYBE to attend [prospect_company_name]'s webinar.

## Prospect's Business Context
- Company: [prospect_company_name]
- Their clients are: [icp.role]s at [icp.company_size] companies in [icp.industry]
- Core pain they solve: [customer_pain]
- Result they deliver: [result_delivered]
- Case study (use verbatim numbers only): [case_study.numbers] — [case_study.result]
- Webinar angle: [webinar_angle]

## Format Rules
[format_brains.brain_content — loaded from CompeteIQ Supabase at runtime]

## Copywriting Principles
[copywriting_principles — loaded from CompeteIQ Supabase at runtime, all active principles]

## Real Examples (study these — match this voice and structure exactly)
[format_brains.example_outputs — up to 3 few-shot examples]

## Output Format
Respond with valid JSON only. No markdown, no explanation, no preamble.

{
  "variants": [
    {
      "variant": "A",
      "style": "Curiosity-first (Revealed style)",
      "title": "...",
      "description": "..."
    },
    {
      "variant": "B",
      "style": "Outcome-first (Hormozi style)",
      "title": "...",
      "description": "..."
    },
    {
      "variant": "C",
      "style": "Mechanism-first (Kennedy style)",
      "title": "...",
      "description": "..."
    }
  ]
}

Rules:
- Generate exactly 3 variants (A, B, C)
- Titles: max 60 characters. Front-load the most critical signal (ICP role or outcome)
  in the first 40 characters — the title must make sense if truncated at 40 chars.
- Descriptions: max 300 words. Follow the 9-part structure from Format Rules above.
- All proof numbers must be verbatim from the brief — never fabricate
- Each title must pass the gut check: a [icp.role] reads it and thinks "oh shit, that's for me"
```

### 4.2 User Prompt

```
Generate calendar blocker copy for this prospect's webinar:
- Prospect company: [prospect_company_name]
- Target segment: [icp.role]s at [icp.company_size] [icp.industry] companies
[if geography] - Geography: [icp.geography]
- Pain they solve: [customer_pain]
- Result they deliver: [result_delivered]
[if case_study] - Client proof: [case_study.client_description] achieved [case_study.result] ([case_study.numbers])
[if webinar_angle] - Webinar angle: [webinar_angle]
[if no case_study] - No specific case study provided — use best-fit framing from examples or segment-agnostic language
```

### 4.3 Prompt File Location

System prompt template: `deal-forge/prompts/webinar_titles_system.txt`
User prompt template: `deal-forge/prompts/webinar_titles_user.txt`
Fallback format rules: `deal-forge/prompts/webinar_titles_fallback_format.txt`

Prompts are plain text templates with `[bracket]` placeholders. They are NOT hardcoded in application code — loaded at runtime and interpolated before sending to Claude.

---

## 5. Output Schema

Stored in `tasks.output_data` (JSONB column on `tasks` table). This spec is the single source of truth — `prompts/webinar_titles_system.txt` is authored against it.

```json
{
  "_analysis": {
    "host": "company name from the brief",
    "attendee": "the reader — who is invited to attend",
    "attendees_customer": "who the attendee sells to — almost never appears in copy directly",
    "attendee_outcome": "the business outcome the attendee wants",
    "geography_class": "us | ca | other",
    "compliance_language_allowed": ["array of terms permitted under the geography class"],
    "supported_claims": {
      "verbatim_numbers": ["only numbers/timeframes present in the brief — empty array if none"],
      "goal_revenue": "string | null — the prospect's stated goal revenue, if any",
      "current_acquisition_channels": ["array — how they currently get clients per the brief"]
    },
    "risk_flags": ["zero or more canonical strings from prompt STEP 8"],
    "confidence": "integer 1-10"
  },
  "variants": [
    {
      "variant": "A",
      "style": "Curiosity-first (Revealed style)",
      "title": "string — max 60 chars, first 40 must make sense if truncated. NO emojis.",
      "conditional_opener": "string — ONE sentence, qualifies the reader by self-identification",
      "proof_story": "string | null — ONE client story with VERBATIM numbers from the brief; null when no proof numbers",
      "contrast_frame": "string — ONE sentence; shape adapts to host business_model (educational vs delivery)",
      "session_promise": "string — ONE sentence; the host's commitment to the attendee",
      "rsvp_block": "string — canonical 'Click YES or MAYBE…' two-line block",
      "bullets": ["string — 4-5 SPECIFIC PROMISES, never topics. Verb set adapts to business_model. Prefix with 💥 or 🚀."],
      "reframe_line": "string — ONE sentence; 'Most [segment] don't have a [obvious problem] — they have a [real underlying problem].'",
      "urgency_close": "string — ONE sentence; no false scarcity",
      "ps_replay": "string — 'P.S. Want the replay? Just register through the official page.'",
      "for_line": "string — ONE sentence describing who specifically should attend",
      "_score": {
        "icp_accuracy":     "integer 0-30",
        "pain_relevance":   "integer 0-25",
        "outcome_clarity":  "integer 0-20",
        "compliance_safety":"integer 0-15",
        "curiosity_appeal": "integer 0-10",
        "total":            "integer 0-100 (sum)"
      }
    },
    { "variant": "B", "style": "Outcome-first (Hormozi style)", "...": "same 12 content fields + _score" },
    { "variant": "C", "style": "Mechanism-first (Kennedy style) / Process-transparency for delivery hosts", "...": "same 12 content fields + _score" }
  ],
  "_recommended_index": "integer 0|1|2 — variant with highest _score.total",
  "_meta": {
    "brain": "{ principles_count, examples_count, config_updated_at, loaded_at }",
    "generated_at": "ISO timestamp",
    "inputs": "{ has_case_study, has_host_bio, has_brand_tagline, has_website_summary, has_pain_quote, has_goal_quote }",
    "analysis": "(mirror of top-level _analysis)",
    "recommended_index": "(mirror of top-level _recommended_index)",
    "confidence": "integer | null",
    "risk_flags": ["…"]
  }
}
```

**Hard requirements per variant.** `title`, `conditional_opener`, `rsvp_block`, `bullets`, `for_line` are always non-null. `proof_story` is `null` only when the brief has no verbatim proof numbers. The other six narrative fields (`contrast_frame`, `session_promise`, `reframe_line`, `urgency_close`, `ps_replay`) are always non-null. `bullets` is always an array of 4–5 strings. The legacy 4-field schema (`{title, hook, bullets, for_line}` ± fused `description`) is REMOVED — no consumer reads it and the generator hard-fails any variant in that shape.

---

## 6. Output Validation (Post-Generation)

Run these checks immediately after JSON parse in `generateWebinarTitles`. Any failure throws — no retry, no fallback — so regressions surface on the Render dashboard and in `tasks.error_message`.

| Check | Rule | Action on failure |
|-------|------|-----------------------|
| Top-level shape | `variants` array of length 3; `_recommended_index ∈ {0,1,2}` (derive from `_score.total` if missing) | Throw |
| Per-variant required fields | `title`, `conditional_opener`, `rsvp_block`, `bullets`, `for_line` all non-null | Throw with the missing field list |
| No legacy `description` field | `variant.description` must NOT be a non-empty string | Throw — model has been taught the wrong shape; check `examples_block` |
| Bullets shape | `Array.isArray(bullets)` and `length >= 3` | Throw |
| Title length | Each title ≤ 60 characters | Log warning (soft) |
| Valid JSON | `extractJsonObject(raw)` succeeds | Throw |

---

## 7. State Machine Transitions

```
pending
  ↓ (extract completed, check required fields)
  ├─ required fields present → processing
  └─ required fields missing → needs_input
       ↓ (rep submits missing fields via dashboard)
     pending → processing
       ↓
  ├─ generation + validation succeeds → completed
  └─ generation fails after retry → failed
```

---

## 8. Error Handling

| Scenario | Behavior |
|----------|----------|
| Required ICP/pain fields null | `needs_input` status, no Claude call made |
| CompeteIQ DB unreachable | Log warning, fall back to `webinar_titles_fallback_format.txt`, continue |
| Claude API timeout | Retry once after 5s; if second timeout → `failed` |
| Claude returns invalid JSON | Retry once with JSON-only instruction; if still invalid → `failed` |
| Word count > 220 | Retry once with explicit word limit; if still over → truncate + log warning |
| No format brain found | Use fallback format rules, log warning |

---

## 9. Schema Change Required: `needs_input` Status

The `tasks.status` enum needs a new value. Current enum (assumed):
```sql
CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
```

Required migration:
```sql
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'needs_input'));
```

This migration must run before the `webinar_titles` task handler is deployed. All other tasks that do NOT need this status are unaffected — they never set it.

The `needs_input` status also applies to any future copy generation task that depends on fields a rep must supply manually (e.g., `email_sequence`, `calendar_visual`).

---

## 10. Idempotency

- Task ID is the unique key. Re-running a completed task overwrites `tasks.output_data` (upsert, not duplicate)
- Re-running a `needs_input` task after fields are populated works normally — treated as fresh `pending`
- `format_brain_version` is captured in output to enable re-generation if format rules change

---

## 11. Cost Estimate

| Item | Estimate |
|------|----------|
| Input tokens per call | ~800 (system prompt ~600, user prompt ~200) |
| Output tokens per call | ~600 (3 variants × title + 220-word description) |
| Cost per job (Sonnet) | ~$0.011 ($0.0024 input + $0.009 output) |
| Cost per 100 jobs | ~$1.10 |

Cost is negligible at this volume. No pre-flight cost gate needed.

---

## 12. What's Not in v1

- Streaming SSE (generate and show in real-time) — added in Phase 2 when dashboard is built
- Per-rep brand voice customization — same format brain for all reps in v1
- Regeneration button per variant — Phase 2 dashboard feature
- Scoring / evaluation of variants — Phase 3
- Automatic re-generation when format brain is updated — Phase 3
