# Hyperbach adapter and migration

Prepared from the supplied actor input schema and sample output. No paid actor run or live configuration change is part of these source changes.

Actor: `hyperbach/upwork-scraper-ai` (`RDMDCh3d2XZKng8Mz`).
Saved task: `doradoasesino~siv-job-feed-hyperbach` (`ayZDNeptTaU4NUy6M`).

## Adapter behavior

Neatrat remains the default provider. Select Hyperbach explicitly using `APIFY_PROVIDER=hyperbach`; setting only the new task ID is rejected for the known Hyperbach task. Hyperbach synchronization reads task metadata and verifies the actor ID before changing any input. Each queued sync is bound to its provider and task: changing either requires saving current settings or pressing Sync saved settings to Apify now. Old queued Neatrat settings cannot be sent to the new Hyperbach task.

Hyperbach input derives from the dashboard's actual saved filters:

- `keywords`: quoted phrases joined with OR; `keywords_match: strict`. When title-only is enabled, also send the documented `title` text filter with OR alternatives. Do not use `title_search`, whose entries are ANDed. Remove the managed title restriction when title-only is disabled. The writer still checks title keywords against Upwork details, since provider substring matching may be broader than local word matching.
- `client_location`: countries joined with OR, SWE normalized to Sweden. Empty countries mean no country restriction.
- `buyer_payment_verified: true` only when requested; otherwise remove the field entirely. False means unverified-only, not any client.
- `date_posted: 60m` maintains the agreed one-hour window.
- `notifications_only: true` uses the actor's documented feed cursor and avoids billing overlapping matches repeatedly. Preserve clientId; do not change it to repeat the same feed.
- `estimate: false` selects actual job rows rather than an estimate report.
- Preserve limit and unrelated actor-specific filters. An existing nonempty output projection is expanded to include url, title and date_posted. Preserve an empty projection, which means all fields.
- Remove old Neatrat search/pagination fields and any historical page_after cursor. Budget minimums are enforced by the writer's existing checks against Upwork details, before Claude or submission, instead of combining fixed-only and hourly-only actor filters. Existing Hyperbach-specific filters are otherwise retained and can further narrow results.

Import prefers date_posted over Neatrat's date aliases. The supplied sample is a historical example, not evidence of a current job or live end-to-end behavior. Its created_at is feed ingestion time, not the publication time. Existing canonical URL parsing removes the ~02 prefix; canonical intake and proposal checks deduplicate sources.

## Deployment and live switch order

1. Deploy the reviewed provider-aware source change and confirm Cloudflare Ready. Keep schedules disabled.
2. Configure the Worker variables together: APIFY_PROVIDER=hyperbach and APIFY_TASK_ID=ayZDNeptTaU4NUy6M. Preserve APIFY_TOKEN, APIFY_WEBHOOK_SECRET, TOKEN_KEY, D1 bindings and OAuth/Loom credentials. Do not publish a task-ID-only switch and then sync it using the Neatrat adapter.
3. Refresh the app, review its saved discovery filters, then press Sync saved settings to Apify now. It reads/writes input only; it does not run the actor or enable schedules. Confirm Applied and inspect the new task's input, especially date_posted, payment verification and clientId. Apify metadata/input permissions are required.
4. Configure ONE task-scoped Apify ACTOR.RUN.SUCCEEDED integration to the existing /api/apify-webhook endpoint using the same private Bearer secret. Use the default resource notification with its defaultDatasetId or the existing resource payload. Prefer dataset notifications: the receiver imports pages of 20 with durable checkpoints. Do not additionally configure the actor-native webhook_url/webhook_headers, which creates another delivery route; direct payloads have smaller size/item limits.
5. Keep the old Neatrat schedule and webhook disabled. The old webhook cannot be assumed inert merely because its schedule is disabled: manual runs still trigger it.
6. A paid test needs the user's explicit approval; none was started here. Verify a real webhook delivery, dataset import/deduplication, actual job dates and writer filters while Sending remains off. Notifications-only feed cursor behavior and live actor search results still require verification.
7. Enable a single schedule only after successful verification and a spending decision. Keep the existing monthly limit; reported remaining balance is not independently verified by this patch.

## Automatic save synchronization

Saving dashboard settings durably queues the desired input and starts synchronization using the Worker's waitUntil background lifecycle. The explicit Sync button also acknowledges its queued request without waiting for remote Apify calls on the browser connection. The cron retains retry responsibility if the immediate background attempt is interrupted or fails. A lightweight status endpoint refreshes pending sync status every three seconds while the page is visible; Applied still requires provider readback. Network failures advise checking saved state rather than implying the settings were necessarily lost. This does not start an actor, change a schedule or alter the search filters.

## Per-run timestamps

The Proposals page includes Recent Apify run timings, showing the latest 20 persisted webhook deliveries with separate actor start, actor finish and webhook receipt timestamps (including seconds in the device time zone), duration, import status, new jobs and duplicates. Run metadata is recorded from flat resource payloads or resource envelopes; unavailable historical timestamps remain explicitly unavailable. Only successful actor runs delivered to this receiver appear: failed, running or missing-webhook runs are not inferred. Empty successful dataset deliveries appear after import too. Retried notifications preserve one receipt and its original timing. This uses the existing receipt store with a metadata-only history projection; it adds no actor runs, provider polling calls or database tables.
