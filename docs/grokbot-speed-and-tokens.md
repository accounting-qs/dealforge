# Grokbot + Deal Forge: speed and token use

For Lloyd and Gary. What makes Grokbot slow and expensive when it works on a Deal Forge, what Deal Forge now does about it, and what has to change on Grokbot's side.

## Why it was slow (5–10 minutes)

- **It edited by copy-paste.** No single call covered "change this field", so closers asked Grokbot for the text and pasted it into Deal Forge by hand.
- **Each edit took several round trips.** Grokbot read the whole job, then wrote through whichever of `update_brief`, `update_icp` or `set_overrides` covered that screen, then read the job again to check.
- **Creating a job runs the whole pipeline.** That covers transcript extraction, the Apollo lead search, invite copy and the calendar page. It takes a few minutes whether a rep or Grokbot starts it, and Grokbot cannot make it faster.
- **Deal Forge builds one step at a time, across all jobs.** If two closers start jobs at the same moment, the second waits behind the first.
- **Grokbot went quiet while it waited.** The closer couldn't tell a slow job from a stuck one.
- **Regenerating copy calls Claude.** A new set of invite titles takes about a minute or two either way.

## What Deal Forge does now

- **One read, one write.** `get_editable_fields` returns every field a rep can change, with the path that edits it. `edit_fields` applies any number of changes in a single call and returns in under a second. Typical edits (TAM, invite titles, webinar title, deck slides, brief fields, case studies, V1/V2) need no Claude call and no rerun.
- **Small answers.** `get_editable_fields` with `sections: ["invite"]` is about 2 KB. The full catalog is about 11 KB. A `get_job` with leads can reach 90 KB.
- **No second extraction.** A job created from the New Job screen no longer runs Claude over the same call twice. That saves one Claude call and about 30 seconds before the rest of the pipeline starts.
- **Edits show up straight away.** The shareable calendar page re-renders as soon as an invite title or description changes, with no new Claude call.
- **Status updates with a time estimate.** `get_progress` says what Deal Forge is doing, how many steps are done, roughly how long is left, and anything that failed or is stuck. It comes as one sentence Grokbot can send the closer.
  - The estimate uses how long each step really took on recent jobs, plus the jobs queued ahead.
  - It also says how long to wait before checking again, so Grokbot doesn't burn tokens polling.

**Rule of thumb for the team:** an edit through Grokbot should now be as fast as typing it. A new job, or regenerated copy, takes as long as it takes in Deal Forge itself, and Grokbot now says how long while it waits. Closers in a hurry can start those in Deal Forge and let Grokbot do the edits afterwards.

**Steps now run side by side (2026-10-22).**
- **What changed:** Deal Forge runs a job's independent steps together, up to four at once across all jobs. Each step still starts only after every step it reads from has finished, so the output is the same.
- **Measured on 80 recent jobs:** a typical new job drops from about 2.6 minutes to about 1.9. The slow cases, which were mostly jobs stuck behind another job started at the same moment, drop from 6.4 minutes to about 2.4 (the 90th percentile).
- **The floor that remains:** reading the transcript (~56 s), then writing the invite copy (~47 s), then the calendar page (~9 s). Each of these needs the one before it.

## Cutting Grokbot's tokens (Grokbot-side changes)

Every step Grokbot takes re-sends its system prompt, the tool list and the conversation so far, so the levers are:

1. **Keep the start of every request identical** so prompt caching applies. xAI bills a repeated prompt prefix as cached input, at a lower rate; check their current pricing page for the size of the discount. Put the system prompt and tool list first, and anything that changes per request (dates, the prospect's name) after them.
2. **Only load the tools Grokbot uses.** The Deal Forge tool list is about 8k tokens per request. `allowed_tools` in the connector config can drop the ones `edit_fields` replaces (`set_overrides`, `update_brief`, `update_icp`, `assign_rep`) and the admin ones (`worker_status`, `delete_job`). That saves roughly 3–4k tokens on every step.
3. **Read narrowly.** Use `get_editable_fields` with `sections`, not `get_job` with `include: ["leads", "brief"]`. One big read stays in the conversation and is paid for again on every later step.
4. **Compaction rules.** Once a tool result has been used, keep only what matters: the job id, what changed, and the link. Start a fresh conversation per prospect rather than one running thread.
5. **Check progress at the pace Deal Forge sets.** `get_progress` returns `next_check_in_seconds` (20–60 s). A regenerate takes a minute or two however often you ask, and every check is a paid step.
6. **Batch edits.** Several changes go in one `edit_fields` call, not one call per field.

Items 1–6 are configuration and prompt changes in Grokbot. Nothing in Deal Forge needs to change for them.
