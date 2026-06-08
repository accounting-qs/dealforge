# Connecting a Zoom account to Deal Forge

Deal Forge can pull a call's transcript from **Zoom** as a fallback for when Fireflies
doesn't join. This guide connects your company Zoom account once; after that, Zoom
cloud-recording transcripts become available to the pipeline.

It uses **Server-to-Server OAuth** — one app for the whole company Zoom account, no
per-rep login. The credentials are entered **in the app** (Settings → Integrations →
Zoom) and stored in the database (`sales_assets.zoom_config`), not in code.

---

## Part 1 — Create the Zoom app (admin, one-time, ~5 min)

You need to be a Zoom **account admin** with access to the Marketplace.

1. Go to **https://marketplace.zoom.us** → **Develop** → **Build App**.
2. Choose **Server-to-Server OAuth** → give it a name (e.g. `Deal Forge`) → **Create**.
3. On the **App Credentials** tab, copy these three values — you'll paste them into Deal Forge:
   - **Account ID**
   - **Client ID**
   - **Client Secret**
4. Fill in the required **Information** fields (company name, developer contact) — Zoom won't let you activate without them.
5. On the **Scopes** tab → **Add Scopes**, add these (search by name).
   **Required** (connection + verification — what the app uses today):
   - `cloud_recording:read:list_user_recordings:admin` — list a user's cloud recordings
   - `cloud_recording:read:recording:admin` — read recording / transcript files
   - `user:read:list_users:admin` — list users
   - `user:read:user:admin` — resolve a rep email → Zoom user

   **For attendee-email matching** (matches a Zoom recording to the prospect by email, like Fireflies' EXACT EMAIL — **requires a paid plan**):
   - `report:read:list_meeting_participants:admin` — participant list + emails via the **Report API** (**Pro plan or higher** — use this one)
   - `dashboard:read:list_meeting_participants:admin` — same via the **Dashboard API** (**Business plan or higher**; alternative only if you can't use Reports)

   > Zoom only includes a participant's email if they joined signed-in or via registration; guests often have none, so Deal Forge falls back to title+date matching when the email is missing.
6. On the **Activation** tab → **Activate** the app.

> If your Zoom UI still shows the older (non-granular) scopes, the equivalents are
> `cloud_recording:read:admin` and `user:read:admin`.

## Part 2 — Turn on cloud recording + transcripts (admin)

Without these, the API either sees nothing or returns recordings with no transcript.

In **Zoom Admin → Account Management → Account Settings → Recording**:
- **Cloud recording** → **ON** (local recordings are *not* reachable via the API).
- **Create audio transcript** → **ON** (under the Cloud recording section).

These apply going forward. Calls recorded before they were enabled won't have transcripts.

## Part 3 — Enter the credentials in Deal Forge

1. Open the app → **Settings** → **Integrations** → **Zoom**.
2. Paste the **Account ID**, **Client ID** and **Client Secret** from Part 1.
3. Click **Save credentials**. The status chip turns **● Configured**.
4. Click **Test connection**:
   - Leave the email blank to just verify the connection, **or**
   - Enter a rep's email (someone who records to the Zoom cloud) to list their recent
     recordings and whether each has a transcript.

Expected results:
- **✓ Connected · N user(s) visible** — credentials and scopes are good.
- **▲ Token OK, but a Zoom call failed** — usually a missing scope; re-check Part 1 step 5 and re-activate.
- **✗ Not connected** — Account ID / Client ID / Client Secret wrong, or the app isn't activated.
- A rep's recordings each show **transcript ✓** or **no transcript** (the latter means Part 2's "Create audio transcript" was off when the call was recorded).

---

## Where things live (for developers)

| Piece | Location |
|---|---|
| Credentials store (singleton row) | `sales_assets.zoom_config` — migration `supabase/migrations/20260608_zoom_config.sql` |
| Read creds (DB, env fallback) | `getZoomCreds()` in `server.js` |
| Token mint + cache (~1h) | `getZoomToken()` / `invalidateZoomToken()` in `server.js` |
| API helper | `zoomQuery(endpoint, method, body)` in `server.js` |
| Save / read creds (secret masked) | `PUT` / `GET /api/admin/zoom-config` |
| Connection test | `GET /api/zoom/test` (optional `?email=`) |
| Settings UI | Settings → Integrations → Zoom (`settings.html`) |

**Env-var fallback (optional):** if `sales_assets.zoom_config` is empty, `getZoomCreds()`
falls back to `ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET`. Normal setup
uses the in-app form, so these can stay blank.

**Apply the migration** before first use (creates the table + grants). Per the project's
schema rules, run `/schema-review` on `20260608_zoom_config.sql` first, then apply it to
Supabase (it mirrors the existing `copy_brain_config` table exactly).

> **Scope:** this connects the account and verifies access. Actually ingesting Zoom
> transcripts into the call picker (writing them into the `calls` table alongside
> Fireflies, parsing the VTT, dedup) is a separate follow-on and will touch
> `specs/extract.md` — see the project plan.
