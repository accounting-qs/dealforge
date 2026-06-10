# Task Spec: zoom_transcript_ingest

**Stage:** Pre-pipeline (prefetch / job creation) + amends `extract`
**Status:** Draft — awaiting sign-off
**Depends on:** Zoom connection layer (`getZoomToken` / `zoomQuery` / `getZoomCreds` / `zoom_config`) — built & verified in prod
**Amends:** `specs/extract.md` §2 (Input Contract) and §5 (Processing Logic)

---

## Section 1 — Purpose

When Fireflies misses a Call 1, the rep can use the Zoom cloud-recording transcript instead. The **New Job picker lists candidates from BOTH Fireflies and Zoom**, defaults to the Fireflies match, and lets the rep pick a Zoom call or go Zoom-only. The chosen transcript (`source` + `id`) becomes authoritative and feeds the same brief extractor (`extractBriefFromTranscript`).

This also fixes a latent issue: `handleExtract` currently re-searches Fireflies by email and ignores the rep's specific pick. This spec makes the pick authoritative for both sources.

---

## Section 2 — Input Contract

Resolved at prefetch (already available): `prospect_email`, prospect `name`, `company`, `website`, and `rep` (from GHL).

| Field | Use |
|---|---|
| `prospect_email` | Zoom attendee-email match (when present in participant data) |
| prospect `name` + `company` | Zoom **title** match (primary — guest emails are often absent) |
| date window | recency filter; default **last 45 days** |

---

## Section 3 — External API Calls (Zoom, via `zoomQuery`)

1. **List recordings:** `GET /accounts/{accountId}/recordings?from=YYYY-MM-DD&to=YYYY-MM-DD&page_size=100`
   - Scope: `cloud_recording:read:list_account_recordings:admin` (fallback per-user: `/users/{repEmail}/recordings` + `list_user_recordings`).
   - Returns `meetings[]`: `{ uuid, id, topic, start_time, duration, recording_files[] }`.
2. **Transcript file:** from the chosen recording's `recording_files[]`, the entry with `file_type === 'TRANSCRIPT'` (a `.VTT`). Download its `download_url` with the access token (`?access_token=` or `Authorization: Bearer`). Scope: `cloud_recording:read:recording:admin`.
3. **Attendee emails (hybrid match — Pro+):** `GET /report/meetings/{meetingUUID}/participants?page_size=300`
   - Scope: `report:read:list_meeting_participants:admin` (Pro+). `meetingUUID` **double-URL-encoded** if it contains `/` or `+`.
   - Returns `participants[]` with `name` + `user_email` (often blank for guests).
   - On 4xx (scope/plan missing) → **skip email match silently**, log once, continue with title match.

---

## Section 4 — Discovery & Matching Logic

For `(prospect_email, name, company)`:
1. Pull account recordings in the date window.
2. Compute `match_kind` per recording:
   - `exact_email` — `prospect_email` ∈ participant emails (report API). **Highest.**
   - `title` — normalized prospect name **or** company appears in `topic`.
   - `recent` — neither, but within window (low confidence; surfaced only if few/no better matches).
3. Call the report/participants API **only for the top title/recency candidates** (avoid N calls), or skip entirely if the report scope is absent.
4. Include recordings with no TRANSCRIPT file but mark `has_transcript: false` (shown disabled — can't feed extract).
5. Rank: `exact_email` → `title` → `recent`; tiebreak `start_time` desc, then `duration` desc. Cap at **top 8** Zoom candidates.

---

## Section 5 — Candidate Shape & Merge with Fireflies

Zoom candidate (aligned with the existing `/api/prefetch` candidate shape):
```json
{ "id": "<recording uuid>", "source": "zoom", "title": "...", "duration": 26,
  "date": "ISO", "attendees": [{"email":"...","name":"..."}],
  "match_kind": "exact_email|title|recent", "has_transcript": true }
```
- Fireflies candidates gain `"source": "fireflies"`.
- **Merge:** concatenate both lists.
- **Dedup (mark, don't drop — per "list everything from both"):** same call if `same date` AND `|duration delta| ≤ 3 min` AND title similar → keep both, tag the Zoom one `dup_of_fireflies: true` so the UI can de-emphasize it.
- **Default selection (suggested):** Fireflies `exact_email` → Fireflies any → Zoom `exact_email` → Zoom `title`.

---

## Section 6 — Picker Contract (UI)

Files: **mockup-dashboard.html** (served at `/dashboard`) **and calls.html** (served at `/calls`) — both contain the picker.
- Section header: "Transcript" (was "FIREFLIES TRANSCRIPT").
- Each row: **source badge** (Fireflies / Zoom) + **match badge** (EXACT EMAIL / TITLE / RECENT) + title + meta (date · duration · attendees). Zoom rows with `has_transcript:false` render disabled with a "no transcript" note.
- Default-selected = suggested per §5. Retain **Skip** and **paste-Fireflies-link** options.
- Selection captured as `{ source, id }`.
- **Title search fallback** — a search box (`GET /api/transcripts/search?prefetch_id=&q=`) title-searches **both** sources at once (Fireflies `keyword` query, title-filtered, with a 408 retry; Zoom = the cached recordings list filtered by topic) and renders the merged results into the same picker. Results are seeded into the prefetch's `candidatesById` so a Zoom pick resolves via its download URL. This is the reliable manual path when auto-match misses (esp. since Zoom guests have no email).

---

## Section 7 — Job Storage

`POST /api/jobs` payload adds `transcript_source: 'fireflies'|'zoom'` alongside `transcript_id`. Stored on the brief as `_source: { source, id, picked_by, picked_at }` (generalizes the current `fireflies_transcript_id`).

---

## Section 8 — Extract Changes (amends extract.md §5)

`handleExtract` resolves the transcript by **honoring the pick**:
1. If job `_source` has `{ source, id }`:
   - `zoom` → `fetchZoomTranscript(id)`: get recording → find TRANSCRIPT file → download VTT → `parseZoomVtt` → `_annotateTranscript`. `transcriptSource = 'live_zoom'`.
   - `fireflies` → `fetchTranscriptDetail(id)` (the specific transcript).
2. Else (legacy / no pick): current path — `findApprovedCallsFromDB` → `findFirefliesTranscripts`.
3. If the chosen transcript fetch fails → log, fall back to search, reflect in `_meta`.

---

## Section 9 — VTT Parsing

New helper `parseZoomVtt(vttText) → [{ speaker_name, text }]`:
- Strip `WEBVTT` header, cue numbers, and timestamp lines.
- A cue body of form `Name: text` → `{ speaker_name: 'Name', text }`; otherwise `speaker_name: null`.
- Merge consecutive same-speaker lines.
- Output shape matches what `_annotateTranscript(sentences, attendees, repEmailSet)` already consumes (`{ speaker_name, text }`), so Zoom reuses the existing rep/prospect labeling.

---

## Section 10 — Output / Source values

`extracted._meta.transcript.source ∈ { 'live_fireflies', 'live_zoom', 'db_approved', 'none' }`.

---

## Section 11 — Error Handling & Scopes

| Condition | Behavior |
|---|---|
| Zoom list/recording call returns null/error | No Zoom candidates; Fireflies still shown. **Never blocks prefetch.** |
| Report participants 4xx (missing scope/plan) | Skip email match, use title match. Log once. |
| Chosen Zoom recording has no TRANSCRIPT file | Extract fails gracefully: "Selected Zoom call has no transcript — pick another." |
| VTT download 401 | `invalidateZoomToken()` + retry once. |

**Scopes:** `cloud_recording:read:list_account_recordings:admin`, `cloud_recording:read:recording:admin` (required); `report:read:list_meeting_participants:admin` (email matching — **Pro+**).

---

## Section 12 — Out of Scope (this phase)

- Calls-library Zoom sync (`syncZoomToCallLibrary` into the `calls` table) — not needed for the picker; defer.
- Dashboard-API participant matching (Business+).
- Auto-trigger via Zoom webhook (`recording.transcript_completed`).

---

## Sign-Off

- [ ] Approved by: __________  Date: __________
