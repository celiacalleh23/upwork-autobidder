# Separate scan-only Worker

Implemented locally; nothing deployed or provisioned. `wrangler.toml` remains unchanged.
The existing additional-account scan continues until an explicit cutover. Do not run
both scanners against the same Upwork account: their independent databases cannot
share rolling quotas.

## Architecture

`src/scanner/index.ts` is an independent entry point with its own D1, encrypted
OAuth registration/session, TOKEN_KEY, admin bearer secret, settings, pause state,
quota reservations and outbox. It starts paused on a fresh database. It reuses the
scan-purpose MCP client, which permits only list_accounts and find_jobs/search.
It exposes no proposal-writing or sending routes and needs no Claude/Loom secrets.
Account warnings pause only this Worker. Resume explicitly after reviewing them.

Discovery remains at :15/:45, at most 12 keyword requests per run, ten results per
keyword, with the existing one-hour freshness window and keyword rotation. Rolling
limits remain 15/minute, 150/hour, 750/day, including MCP retries. Duplicate cron
slots are claimed before network requests as before; a failed scan does not replay
its slot. Delivery failures never cause another Upwork search.

Each discovered job is inserted into `scan_outbox` by canonical job ID before the
keyword cursor advances. A separate minute cron sends up to five due jobs with a
15-second timeout and a database lease. Only a successful response with
`{accepted:true,id:<matching canonical id>}` completes a delivery. All other outcomes
are retained indefinitely with exponential retry delays from one minute to one hour.
Delivered rows remain as deduplication receipts. Inspect pending count/next time at
`GET /status`; inspect attempts and last_error in the scanner D1 for troubleshooting.
No automatic outbox deletion is performed. Monitor storage and backlog.

The primary receiver `POST /api/jobs/scan-intake` is off unless SCAN_INTAKE_SECRET
has at least 32 characters. It requires a bearer token and bounded JSON body, accepts
only the canonical link, title and posting date, and forces automatic intake. Existing
jobs retain their outcome. It shares the normal intake lease and 30 accepted jobs/hour
cap; busy/capped intake returns 429 and is retried. A lost acknowledgement safely
replays into canonical deduplication. The generic manual intake route is unchanged.

## Staging validation (before production changes)

1. Run `npm run check`. Both entry points are bundled locally.
2. Create two **new** D1 databases for scanner staging and receiver staging. Replace
   the placeholder IDs in `wrangler.scanner.toml` and `wrangler.receiver-staging.toml`.
   Never reuse the production database ID or copy production tokens.
3. Give receiver staging a fresh SCAN_INTAKE_SECRET. Set the scanner's
   JOB_DELIVERY_SECRET to that same value, plus independent TOKEN_KEY and
   SCANNER_ADMIN_SECRET (each 32+ random characters). Set JOB_DELIVERY_URL to the
   receiver staging HTTPS `/api/jobs/scan-intake` URL. Secrets must be set with the
   corresponding explicit `--config` path. Never use unqualified deploy commands.
4. Deploy receiver staging and scanner staging with their explicit config files.
   The receiver staging config has no crons. Scanner discovery remains paused.
5. With `Authorization: Bearer <SCANNER_ADMIN_SECRET>`, POST `/settings` with
   `{"keywords":["Email marketing"],"verifiedOnly":true}`. POST `/oauth/start` with
   `{}`; open the returned URL using the additional account. POST `/oauth/finish`
   with `{"callback":"<full pasted callback URL>"}`. This creates a fresh OAuth
   session encrypted only by the scanner key. Never log the pasted callback or tokens.
6. Before enabling real discovery, disable the legacy additional-account scan in an
   isolated test setup, or use a different test account. Do not overlap sessions'
   scan schedules/budgets. POST `/pause` with `{"paused":false}` to enable discovery.
7. Verify an actual discovered job reaches only receiver staging. Repeat delivery;
   confirm one job and preserved status. Break the delivery secret temporarily,
   verify pending rows/attempts grow and recover after repair. Test 429/backlog recovery,
   duplicate cron delivery, pause, OAuth expiry and account-warning behavior.
   Review quota reservations and logs. Keep production unchanged during these tests.

All administration requests require the admin bearer secret. `/pause` controls
searching; delivery of already persisted jobs continues while searching is paused.
There is no unauthenticated dashboard or token export API. Settings are independent;
copy intended keywords/payment filter explicitly when changing them.

## Reviewed production cutover (not performed)

After staging passes, provision a separate production scanner D1/config with fresh
secrets and a paused scanner. Deploy the tested receiver code to the primary Worker,
set its new SCAN_INTAKE_SECRET, and set EXTERNAL_SCAN_ONLY="true" to stop the legacy
additional scan (bidding at :00/:30 continues). Wait for in-flight legacy scans to end
(the lease is ten minutes); retain its quota history and wait at least 24 hours after
its last search before enabling the new scanner, so daily rolling limits cannot reset
at cutover. Connect the additional account afresh in the new scanner and configure
its independent settings and production receiver URL. Verify receiver auth and a
controlled delivery before resuming scans. Do not migrate the bidding session or DB.

Rollback: pause the external scanner, retain its outbox for retry, stop legacy/external
overlap, and wait the same rolling-quota window before re-enabling legacy discovery
by removing EXTERNAL_SCAN_ONLY. Rotate/revoke delivery secrets if retiring delivery.
No production changes are authorized or executed by the local implementation checks.
