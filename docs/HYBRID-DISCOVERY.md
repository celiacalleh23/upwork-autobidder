# Hybrid discovery rollout

Rollout uses the GitHub main branch connected to Cloudflare Builds. Verify deployment success separately; merging code does not update the external Apify schedule.

After deployment, the existing every-minute sender cron also invokes discovery at :00 and :30. Discovery is independent of Sending on/off, but honors Pause and Upwork account holds. New imports pass through existing writer filters and approval rules; this change does not enable Sending or clear a hold.

Each scan searches up to 12 configured keywords, one documented `find_jobs search` call per keyword, sorted by recency, first 10 results each. More than 12 keywords rotate across scans. That is at most 576 base search requests per day, not 48 requests: 48 is the number of scan rounds. Every actual search attempt including retries reserves a shared D1 slot under rolling limits of 15/minute, 150/hour and 750/24 hours. Counts cover this Worker, not other clients using the same Upwork account. The existing shared 10-second Upwork pacing remains in effect. Quota exhaustion stops that scan; it does not clear account warnings or retry a restriction.

Only valid dated jobs within 60 minutes are imported. Full pages are recorded as truncated in `discovery:lastScan`; pagination is intentionally not implemented, so busy keywords can miss results. Searches use the documented title field; description-only matches are not guaranteed. Jobs with absent/unrecognized timestamps are skipped. Overlap with Apify/manual imports preserves existing outcomes and proposals. The existing shared 30-new-jobs/hour intake cap remains. A failed or interrupted half-hour slot waits until the next scan instead of repeating the whole batch.

## Required live setup

1. Deploy the reviewed branch through the authorized deployment workflow. The user authorized merge and push to main to trigger deployment.
2. In Apify, edit the EXISTING schedule that runs Siv-Job-Scraper. Replace its two-minute cron with `15,45 * * * *`. Use UTC or America/Guayaquil; both give the same quarter-hour minutes. Do not create an additional active schedule. Confirm there are no actor/task schedules duplicating it.
3. Set the task input `maxJobAge` to `{ "value": 60, "unit": "minutes" }`. Preserve its budget ceilings, job types and other input. Dashboard filter saves now request this window too, while preserving unmanaged keys. Compare saved dashboard query/countries/minimums/payment verification before saving: those fields still synchronize to Apify.
4. Finish the authenticated webhook only after the receiver is deployed; validate a genuine successful-run notification and the actor's dated payload. Confirm inherited actor webhooks before deleting or duplicating any integration.
5. Keep Sending off for the first live checks. Confirm Upwork discovery timestamps and errors, Apify scheduled run times and successful imports, canonical deduplication and queue behavior. This code uses the repository's previously verified MCP contract; current live permissions and response format remain unverified.

Apify runs decrease from 720/day to 48/day only once its old two-minute schedule is actually replaced. This is a run-count reduction, not a guaranteed spend reduction; the broader age window can increase results and per-run usage. Keep the existing spending limit.

## Dashboard sync recovery

Every explicit dashboard Save now queues a fresh revision, even when local filters are unchanged, so it can repair an Apify Restore example input. Query phrases are quoted and joined by explicit OR instead of commas; this construction is unit-tested, but the actor's live multi-phrase interpretation still requires provider verification. SWE is normalized to Sweden. The 60-minute window is reapplied. Existing task ceilings are retained; when reset input omits them, restore the owner's previously specified $100,000 fixed and $1,000/hour ceilings. Malformed ranges or minimums above ceilings stop synchronization with an error. Dashboard minimums/countries/payment filters remain authoritative; review them before saving. Task IDs and owner~task-name references are accepted. The dashboard distinguishes missing configuration, pending, applied and failed synchronization. No schedule is changed or actor run started by synchronization.
