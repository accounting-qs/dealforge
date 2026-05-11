# Static assets

Served directly from `/assets/<filename>` (e.g. `/assets/foo.jpg`).

## Expected files

| File | Used by | Purpose |
|---|---|---|
| `lloyd-yip.jpg` (or `.jpeg` / `.png`) | `/lloyd-avatar` route in `server.js` | Founder headshot in the Onboarding tab |

The `/lloyd-avatar` route looks for `lloyd-yip.jpg`, then `lloyd-yip.jpeg`, then `lloyd-yip.png` in that order. If none exist it returns 404 and the page falls back to an initials chip.

Replace files in place to update — no server restart needed (read from disk per request).
