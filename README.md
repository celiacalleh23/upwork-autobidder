# Upwork Auto-Bidder

Siv's private dashboard and bidding pipeline, running on Cloudflare Workers + D1.

**Status: M2 — Upwork connection.** The dashboard, its API, login, settings and the Upwork sign-in
(Settings → Reports and connections → Connect Upwork) are built. The rest of the pipeline (scanner, AI letters,
Loom copies, sender, daily report) plugs into `scheduled()` in `src/index.ts` next.

The Upwork connection needs the `TOKEN_KEY` secret (32+ random characters, e.g. `openssl rand -base64 48`).
It encrypts the stored Upwork sign-in and also signs dashboard sessions, so setting or changing it signs everyone out once.

## What the dashboard does

- **Review first / Auto-submit** switch. Starts in Review. Auto needs a confirmation and a connected Upwork account.
- **Pause all**, with a banner while paused.
- **Today:** jobs scanned and matched, proposals sent against the daily cap, waiting for review, Connects spent, failures.
- **Review queue**, highest match first: edit the letter (5,000-character limit, contact details blocked), approve or skip.
  Approved proposals are not sent instantly: the sender sends them one at a time, respecting the spacing, hourly cap and active hours.
- **Activity log** with status filter, "Undo" on approved items that have not gone out yet, and CSV export.
- **Settings:** keywords and exclusions, filters, letter template and rules, AI disclosure line, bid rules,
  Loom source video, caps and guardrails, report email, connection status.

Defaults follow the approved proposal: Review first, scan every 5 minutes, 15 a day, 3 an hour,
10 minutes apart, 07:00–21:00 US Eastern, Connects floor 20, max 16 Connects per job, no boost,
auto-pause after 3 errors in a row.

## Setup

```bash
npm install
npx wrangler d1 create autobidder          # copy the database_id into wrangler.toml
npx wrangler secret put DASH_PASSWORD
npm run deploy
```

Open the Worker URL and sign in on the login page with `DASH_PASSWORD` (password only, no user name). Sessions last 30 days; changing `DASH_PASSWORD` signs everyone out. Failed sign-ins are logged (lengths only, never values) in the Worker logs.
The tables are created automatically on the first request (`schema.sql`, all `IF NOT EXISTS`).

### Deploying from GitHub (Workers Builds)

Cloudflare dashboard → Workers & Pages → Create → Import a repository → `upwork-autobidder`.
Deploy command: `npx wrangler deploy`. Then add the secrets under the Worker's Settings → Variables and Secrets.
Every push to `main` deploys.

## Local development

```bash
printf 'DASH_PASSWORD=change-me\n' > .dev.vars
npm run db:init:local
npm run db:demo:local      # optional: example proposals, removable from the dashboard
npm run dev                # http://localhost:8787
npm run typecheck
```

## Files

| File | What it holds |
| --- | --- |
| `src/index.ts` | Routing, security headers, cron entry point |
| `src/auth.ts` | Login page, signed session cookie, credential check |
| `src/oauth.ts` | Upwork sign-in: discovery, client registration, PKCE, token refresh, account + Connects check |
| `src/mcp.ts` | Minimal MCP client (Streamable HTTP, JSON or SSE responses) |
| `src/crypto.ts` | AES-GCM encryption at rest, keyed from `TOKEN_KEY` |
| `src/api.ts` | Dashboard API: state, queue, log, CSV, proposal actions, mode, pause, settings |
| `src/settings.ts` | Settings and state shapes, defaults, validation |
| `src/dashboard.html` | The dashboard (single page, no build step) |
| `schema.sql` | D1 tables: `kv`, `jobs`, `proposals`, `runs` |
| `seed-demo.sql` | Example rows, flagged `is_example = 1` |

## API

All routes need a signed-in session (cookie from `/login`). Changes also need the header `x-dashboard: 1`.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/state` | Mode, pause, connections, today's numbers, caps |
| GET / PUT | `/api/settings` | Read / save settings (validated and clamped) |
| POST | `/api/mode` | `{"mode":"review"}` or `{"mode":"auto","confirm":true}` |
| POST | `/api/pause` | `{"paused":true|false}` |
| POST | `/api/upwork/check` | Re-read the Upwork account, tool names and Connects balance |
| POST | `/api/upwork/disconnect` | Forget the Upwork sign-in |
| GET | `/oauth/upwork/start` | Starts the Upwork sign-in (needs a session) |
| GET | `/oauth/upwork/callback` | Upwork returns here; checked by the single-use OAuth state, not the cookie |
| GET | `/api/queue` | Proposals waiting for review |
| PATCH | `/api/proposals/:id` | `{"cover_letter":"…"}` while waiting |
| POST | `/api/proposals/:id/approve` · `/unapprove` · `/skip` | Queue actions |
| GET | `/api/log` · `/api/log.csv` | Activity log, `?status=&limit=&offset=` |
| DELETE | `/api/examples` | Removes example rows |

Proposal statuses: `pending` → `approved` → `submitting` → `submitted`, or `failed`, `skipped`,
`unknown` (Upwork did not confirm clearly; check on Upwork before retrying).

## Next milestones

1. Upwork connection: OAuth sign-in to `https://mcp.upwork.com/mcp` with Rafa's freelancer account, tokens encrypted with `TOKEN_KEY`.
2. Scanner: title search on the keywords, filters, never the same job twice.
3. Claude scoring and letters (`ANTHROPIC_API_KEY`), with the optional disclosure line.
4. Loom: copy the source video and rename it to the job title; 30-day cleanup.
5. Sender: preview → confirm, one at a time, inside caps and active hours; auto-pause on warnings; falls back to Review if Upwork stops allowing automatic confirmation.
6. Daily report email (`RESEND_API_KEY`) at 6 pm.
