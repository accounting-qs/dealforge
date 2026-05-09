# Task Spec: webinar_mock

**Pipeline stage:** 3 — parallel with calendar_visual
**Depends on:** `brand_scrape` completed + `webinar_titles` completed + `prospect_research` completed
**Blocks:** Nothing (final stage)
**Model:** Claude Haiku (live chat message generation)
**Temperature:** 0.7
**Max tokens:** 800
**Status:** FULLY SPECCED

---

## 1. What This Task Does

Generates a self-contained HTML file that simulates a live webinar interface — the "oh shit" moment on Call 2 where the prospect sees exactly what their branded webinar will look like in production.

**Layout:** Two-panel interface mimicking a real webinar platform (WebinarGeek / Zoom Webinar / GoToWebinar aesthetic):
- **Left panel (80%):** Presentation slides — 2 slides, prospect's brand colors and logo applied, slide-navigable with Previous / Next arrows
- **Right panel (20%):** Live chat — AI-generated attendee messages from people matching the prospect's ICP, asking real questions about the topic, with support team messages closing conversions

**The "live" signals:** LIVE badge, attendee count (realistic fake number, e.g. 847), timestamp-style chat messages — all reinforcing that this is a live event, not a recording. This is deliberate: QS's live webinar retention is 2× pre-recorded. The mock needs to communicate that energy.

**What this replaces:** reg_page (cut from pipeline). The calendar invite IS the registration mechanism ("just click Yes"). A reg page would contradict that frictionless narrative. This asset serves the same brand-application purpose while being far more powerful — it shows the full webinar experience, not just a signup form.

---

## 2. Inputs

| Field | Source | Required | Null handling |
|-------|--------|----------|---------------|
| `brand_data.primary_color` | jobs.brand_data | Optional | null → QS default teal (#0D9488) |
| `brand_data.secondary_color` | jobs.brand_data | Optional | null → dark gray (#1F2937) |
| `brand_data.accent_color` | jobs.brand_data | Optional | null → fall back to primary_color |
| `brand_data.font_family` | jobs.brand_data | Optional | null → system sans-serif fallback |
| `brand_data.logo_url` | jobs.brand_data | Optional | null → omit logo, render company name text instead |
| `brand_data.company_name` | jobs.brand_data | Optional | null → extracted_data.prospect.company |
| `brand_data.tagline` | jobs.brand_data | Optional | null → fall back to "How {company} Grows Your Business" subtitle |
| `brand_data.images[]` (type='hero') | jobs.brand_data | Optional | null → no hero overlay, gradient only |
| `webinar_titles.variants[0].title` | tasks.output_data | Required | null → task fails ("no title variant found") |
| `webinar_titles.variants[0].bullets` | tasks.output_data | Optional | null → 3-bullet generic agenda fallback |
| `webinar_titles.variants[0].for_line` | tasks.output_data | Optional | null → omit "for-line" pill on hero |
| `webinar_titles.variants[0].proof_story` | tasks.output_data | Optional | drives Proof slide (priority 1); null → fall back to extracted.angle.proof |
| `research_data.host.name` | jobs.research_data | Required | null → extracted_data.prospect.name |
| `research_data.host.title` | jobs.research_data | Optional | null → "Webinar Host" |
| `research_data.host.bio` | jobs.research_data | Optional | null → omit bio (truncated to 140 chars when present) |
| `research_data.host.headshot_url` | jobs.research_data | Optional | null OR HEAD-check fails → fall back to initial-letter avatar |
| `extracted_data.icp.role` | jobs.extracted_data | Required for chat generation | null → generic ICP attendee names |
| `extracted_data.icp.industry` | jobs.extracted_data | Required for chat generation | null → generic |
| `extracted_data.icp.geography` (or apollo_geography[0]) | jobs.extracted_data | Optional | null → chat omits regional grounding |
| `extracted_data.situation.current_lead_gen` | jobs.extracted_data | Optional | null → chat omits lead-gen-pattern echo |
| `extracted_data.angle.pain` | jobs.extracted_data | Optional | null → chat messages omit pain hooks |
| `extracted_data.angle.result` | jobs.extracted_data | Optional | null → chat messages omit outcome hooks |
| `extracted_data.angle.proof` | jobs.extracted_data | Optional | drives Proof slide fallback (priority 2) |
| `extracted_data.angle.methodology` | jobs.extracted_data | Optional | null → omit methodology micro-line on Proof slide |
| `extracted_data.verbatim.result_quote` | jobs.extracted_data | Optional | drives Proof slide pull-quote when proof_story unavailable |

**LinkedIn photo quality check:** Before injecting the photo, perform a HEAD request to the URL. If the response is not 200 OK, or if width/height metadata indicates under 100×100px, omit the photo. No placeholder shown — just cleaner slide without image.

**Dependency resolution:** Query tasks table for completed brand_scrape, webinar_titles, and prospect_research tasks for this job_id. If any required task is still processing: reschedule in 30s. If any required task failed: this task fails with upstream error surfaced.

---

## 3. Claude Call — Live Chat Generation

Generates realistic attendee chat messages that feel like real people from the prospect's ICP engaging live with the webinar content.

**Model:** Claude Haiku
**Temperature:** 0.7
**Max tokens:** 800

### System prompt
```
You are generating realistic live chat messages for a webinar. These messages should feel authentic — real attendees asking questions, sharing their situations, and responding to content. Include a mix of: questions about the topic, comments about their own struggles, positive reactions, and 2-3 messages where a support team member drives a booking.

Return valid JSON only. No markdown, no explanation.
```

### User prompt
```
Generate 18 live chat messages for this webinar:

Webinar title: {{title}}
Target audience role: {{icp.role}}
Target audience industry: {{icp.industry}}
Core problem they face: {{customer_pain}}
Result they want: {{result_delivered}}

Requirements:
- 14 attendee messages: realistic first names, short messages, mix of questions + reactions + struggles
- 4 support team messages from "Support" or "Team [Host Name]": encourage booking a call, celebrate attendees who booked
- Messages should feel chronologically natural (building engagement over time)
- Attendee questions should reference the webinar topic and feel like someone in {{icp.industry}} would ask them

Return:
{
  "messages": [
    {
      "sender": "string — first name only for attendees, 'Support' for team messages",
      "text": "string — message content, max 15 words",
      "is_team": boolean,
      "timestamp": "string — e.g. '12:14 PM'"
    }
  ]
}
```

### Timestamp generation
Start at a realistic webinar time (e.g., 12:05 PM) and space messages 30-90 seconds apart. Generated server-side before injection.

---

## 4. HTML Template Design

Self-contained HTML. All CSS and JavaScript inline. No external dependencies. Renders correctly offline.

### Overall layout

Full-width interface, dark-themed (webinar platform aesthetic):
- Dark background (#0F1117 or similar near-black)
- Top bar: LIVE badge (red pill, pulsing dot), webinar title (truncated), attendee count
- Left panel (75-80%): slide viewer
- Right panel (20-25%): live chat

### Top bar

```
[● LIVE]  [Webinar Title — truncated]  [👥 847 attending]
```

- LIVE badge: red background, white text, small pulsing red dot (CSS animation)
- Attendee count: randomized between 600–1200 at generation time (realistic for a QS-scale webinar)

### Left panel — Slide viewer

Up to **3 slides** (Proof slide is conditional — omitted when no proof data is available, in which case the deck collapses to 2 slides and `MAX_SLIDES` adjusts). Navigable with Previous / Next arrow buttons (left/right edges of panel) and keyboard arrow keys.

**Brand typography is applied site-wide** via the `--brand-font` CSS variable (sourced from `brand_data.font_family`). Falls back to system sans-serif when null.

**Slide 1 — Hero slide:**
- Background: prospect's `primary_color` with gradient overlay; hero image (from `brand_data.images[type='hero']`) layered when present
- Logo: top-center (if available, white-inverted via CSS `filter: brightness(0) invert(1)`)
- "For-line" pill: small accent-colored pill above title — sourced from `webinar_titles.variants[0].for_line`. Hidden when null.
- Webinar title: large, centered, white text
- Subtitle: `brand_data.tagline` if present, else `"How {company} Grows Your Business"` fallback
- Bottom-left host bar: circular avatar (host headshot if HEAD-check passes, else initial letter) + host name + host title
- Bottom-right QS aggregate proof strip: three small stats — `$500M+ Client Revenue`, `1,400+ Clients Served`, `150K+ Webinar Registrations`. Hardcoded QS-house numbers, NOT prospect-personalized; preserves Quantum Scaling brand authority on the asset.

**Slide 2 — Proof slide (conditional):**
- Background: gradient from `primary_color` to `secondary_color`
- Eyebrow: "Recent Result"
- Heading: first sentence of `webinar_titles.variants[0].proof_story`, OR first sentence of `extracted.angle.proof` as fallback
- Pull-quote: `extracted.verbatim.result_quote` (wrapped in quotes) if available, else second sentence of `extracted.angle.proof`. Left border in accent color.
- Attribution row: `[Name] — [outcome]` extracted from `proof_story` via regex (first occurrence of the `Name → numbers` pattern)
- Methodology micro-line (bottom-left, optional): `extracted.angle.methodology` when present
- **Skip rule:** if `deriveProof()` returns `show: false`, this slide is omitted entirely; nav-dot count and `MAX_SLIDES` adjust.

**Slide 3 (or 2 if no proof) — Agenda slide:**
- Background: `secondary_color`
- Section header: "What You'll Learn Today"
- 3-4 bullet points from `webinar_titles.variants[0].bullets` (truncated to 4 max)
- Bullet checkmarks colored with accent color

**Slide navigation:**
- Bottom-center: prev arrow + dot indicators (count = `MAX_SLIDES`) + next arrow
- Keyboard arrow keys (← / →) work
- Wraps at boundaries (next on last slide → first slide)

### Right panel — Live chat

- Dark panel (#1A1D27 or similar)
- "Live Chat" header with green online indicator
- Scrollable message list (newest at bottom, auto-scroll on load)
- Messages: sender name (bold, colored differently for team vs attendee), timestamp (small, muted), message text
- Team messages: slightly different background tint to distinguish from attendees
- Input field at bottom (disabled/placeholder only — "Chat is view-only in this preview")

---

## 5. Processing Logic

1. Query tasks table: find completed brand_scrape, webinar_titles, prospect_research for this job_id
2. If any required task (webinar_titles, prospect_research) not completed: reschedule in 30s
3. If brand_scrape not completed: proceed with null brand values (use defaults)
4. If any required task failed: set this task `failed`, surface upstream error
5. Extract all input values from task output_data and jobs.extracted_data
6. Run LinkedIn photo quality check (HEAD request, dimension check if possible)
7. Generate timestamps: start at randomized realistic time (11am–2pm), space 30-90s apart for 18 messages
8. Call Claude Haiku to generate 18 live chat messages
9. If Claude returns invalid JSON: retry once. If still invalid: use static fallback chat (see Section 7)
10. Randomize attendee count between 600–1200
11. Load HTML template from `templates/webinar_mock.html`
12. Inject all values (slides content, colors, logo, host info, chat messages, attendee count, timestamps)
13. Upload to Supabase Storage at `{job_id}/webinar_mock.html`
14. Retrieve public URL
15. Write to `tasks.output_data`
16. Mark `completed`

---

## 6. Output Schema

Written to: `tasks.output_data` (JSONB on tasks table)

```json
{
  "url": "https://[supabase].supabase.co/storage/v1/object/public/sales-assets/{job_id}/webinar_mock.html",
  "title": "string — webinar title used",
  "host_name": "string",
  "host_headshot_used": "boolean — true if LinkedIn headshot passed HEAD-check and was injected",
  "proof_slide_shown": "boolean — true if the Proof slide was rendered (deriveProof returned show:true)",
  "attendee_count": 847,
  "messages": "Array<{ sender, text, is_team, timestamp }> — 18 messages, read by rep portal for live chat replay"
}
```

---

## 7. Error Handling

| Scenario | Behavior |
|----------|----------|
| webinar_titles or prospect_research not completed | Reschedule 30s (not failed) |
| brand_scrape not completed | Proceed with defaults (no failure) |
| Either required upstream task failed | This task `failed`, surface upstream error |
| LinkedIn photo fails quality check | Omit photo, continue |
| Claude JSON invalid (2 attempts) | Use static fallback chat messages |
| Supabase Storage upload fails | Retry once. If fails: `failed` |

**Static fallback chat (18 messages, used if Claude fails):**
Generic ICP-adjacent questions and support responses that make the demo functional without personalization. Hardcoded in the template as default content, overwritten when Claude succeeds.

---

## 8. Timeout & Recovery

- **p50 execution time:** ~12 seconds (photo check + Claude call + Storage upload)
- **p99 execution time:** ~35 seconds
- **Task timeout:** 3 minutes
- **Retry idempotent?** Yes — re-upload overwrites same Storage path, URL stable. Attendee count may change slightly on retry (re-randomized) — acceptable.

---

## 9. Idempotency

- Same job_id → same storage path → overwrite on retry
- URL stable across retries
- Chat messages may differ slightly (temp 0.7) — acceptable, both outputs are valid
- Safe to retry

---

## 10. Data Flow

```
[brand_scrape.output_data]            ─────────┐
  (colors, logo, company_name)                  │
[webinar_titles.output_data.titles[0]]─────────┤
  (title, description)                          │
[prospect_research.output_data]       ─────────┤→ [webinar_mock task]
  (name, bio, linkedin_photo_url)               │         ↓
[extracted_data.icp]                  ─────────┤  [LinkedIn photo quality check]
[extracted_data.customer_pain]        ─────────┤         ↓
[extracted_data.result_delivered]     ─────────┘  [Claude Haiku — 18 chat messages]
                                                           ↓
                                              [HTML template injection]
                                                           ↓
                                             [Supabase Storage upload]
                                                           ↓
                                         [tasks.output_data → public URL]
                                                           ↓
                                   [rep dashboard → webinar mock asset card]
                                                           ↓
                                         [screen-share Call 2 — "wow" moment]
```

---

## 11. Sign-Off Checklist

- [x] Replaces reg_page — decision documented (calendar invite IS the reg mechanism)
- [x] Dependency graph complete — Stage 3, parallel with calendar_visual
- [x] Pending-not-failed logic for upstream task timing
- [x] All inputs named, typed, sourced, null-handled (brand defaults defined)
- [x] LinkedIn photo quality check defined (HEAD request + dimension check, omit on failure)
- [x] Claude call: Haiku, temp 0.7, 18 chat messages, prompt written
- [x] Chat message split: 14 attendee + 4 team/support
- [x] Static fallback chat defined — task always completes
- [x] HTML template design specified: dark webinar platform aesthetic, 2-panel layout
- [x] Slide 1 (hero) and Slide 2 (problem/promise) content defined
- [x] Slide navigation: arrow buttons + keyboard, "1/2" indicator
- [x] LIVE badge, pulsing dot, attendee count (600-1200 randomized)
- [x] Chat panel: team messages distinguished, auto-scroll, view-only input
- [x] Timestamp generation: server-side, 30-90s spacing
- [x] Processing logic numbered step-by-step
- [x] Output schema complete
- [x] Error handling table complete
- [x] Timeout set (3 min) — justified
- [x] Idempotency confirmed
- [x] Wireframes deferred to /ux-design phase

**Status:** FULLY SPECCED
