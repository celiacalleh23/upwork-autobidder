# Dashboard and pipeline safety repairs

This patch preserves Workers + D1, Apify ingestion, Claude drafting, Upwork preview/confirmation, Loom copies, Review/Auto, editing, CSV and reporting. It adds no new production database tables. The new import receipts, leases, synchronization state, notification outbox and submission-attempt snapshots use the existing `kv` table. Existing rows remain readable through defaults.

## What users see

- Approve preserves the actual send timestamp. Proposals wait for the configured full minimum gap.
- Pause, Sending, mode and settings are checked again at the confirmation boundary, including after waiting for an Upwork request slot. A request already transmitted cannot be recalled.
- Switching to Review returns unsent Auto approvals to pending; manually approved proposals retain their approval.
- The final preview must satisfy the balance, Connects floor, configured per-job maximum, screening-answer and letter checks. Its cost is recorded rather than the earlier details estimate.
- Settings shows pending/applied/failed Apify synchronization and the last import error. Saving local settings is atomic with queuing the desired discovery input. Sync failures are retried with backoff; an older response cannot acknowledge a newer revision.
- Automatic feed replays keep earlier rejection outcomes. Deliberately adding a rejected link manually still allows requeue, provided no proposal already exists. The hourly quota counts accepted work even after processing.
- The writer enforces keywords, title/body exclusions, verified payment, proposal count, countries and budget. If a required upstream field cannot be verified, it stops with an explanation; it does not silently bypass that filter.
- Screening answers can be edited alongside the letter and bid. Use **Refresh screening questions** when Upwork changes the questions, then edit/save/approve. Any changed question identity or order invalidates the stored answers.
- Unknown confirmations hold further sending. The tool checks exact job identities in bounded Upwork proposal pages. It never treats a missing or malformed response as proof of refusal. After checking Upwork manually, use **Confirm submitted** or **Confirm not sent** in the Activity log. The latter records failure and never retries a proposal automatically.
- Loom cleanup retries unsuccessful deletions, protects pending/approved videos, and tracks known orphan copies. Updating the source link affects pending letters without copies; approved content must first return to review.
- Reports use a retained coverage boundary, so activity after yesterday's report appears in the next digest. Daily delivery has an immutable payload and provider idempotency key. Safety-pause emails wait in an outbox when email configuration is missing. Low-Connects/Loom email flags are not consumed before email is available.
- Account refresh failures preserve the last good snapshot instead of claiming zero. Refresh progress is serialized and can resume. Unreadable Connects dates stop the history checkpoint rather than silently losing rows.

## Controls and limits

All authenticated Upwork callers share the existing D1 request budget. Provider warning holds also apply to manual reads; long Retry-After requests defer work instead of retrying early. This can increase writing/refresh time compared with the unsafe overlapping pipeline. No external Apify schedule is changed.

Leases use owner tokens and conditional release. Writer leases renew between bounded jobs. Critical state patches update only supplied JSON leaves atomically, with a controls version to invalidate stale work. Sender claims compare the reviewed letter, bid, parameters and approval timestamp. An immutable dispatch snapshot is written before confirmation. Unknown/submitting attempts reserve quota and halt new spending until resolved.

Login attempts are limited to 10 per 15-minute bucket per Cloudflare client IP (a shared local bucket in development). Password configuration requires at least 12 non-space characters. Session cookies, PKCE and AES-GCM remain in place. This change does not add individual user roles or per-device session revocation; the dashboard remains a shared-password application.

## Production prerequisites — not performed by this patch

1. Review the patch and its test results before a separate deployment approval. No changes have been pushed, merged, deployed or applied to remote D1.
2. Configure a new high-entropy `APIFY_WEBHOOK_SECRET` and coordinate the provider's Authorization header. A missing/short secret fails closed with 503; an incorrect one returns 401. Do not reuse the historical credential from source.
3. Verify the actual actor's input contract and payload fixtures against `discoveryInput`/`parseDelivery`. The adapter sets a 60-minute job-age window and preserves existing budget ceilings ($100,000 fixed-price in the supplied task JSON), job types, cookies and other unmanaged input keys. Dashboard changes own query, countries, payment verification and budget minimums; they must be aligned with the intended task filters. It updates only `/actor-tasks/{id}/input`; it never updates schedules. Source tests cannot establish the live actor's search semantics or current account permissions.
4. Verify secure `APIFY_TOKEN`, `APIFY_TASK_ID`, email bindings, password strength and Worker resource limits. Existing Claude model/account permission assumptions still require provider-specific validation; no paid API check was performed.
5. Review existing unknown attempts and warnings before resuming production sending. Do not reset or automatically requeue ambiguous submissions. The local unique index cannot coordinate a separate agency/manual sender.

Historical native search, per-proposal outcome funnels, phone notifications, and custom video pages are not added by this repair; those require scope decisions. Loom's internal API and browser-cookie renewal remain dependent on the provider. An external copy that times out before returning an ID cannot be fully reconciled without provider support.

## Validation

`npm run check` performs typecheck, Vitest, Worker bundling and dashboard script syntax validation. The integration suite covers actual routing/state-machine SQL with synthetic services, including valid send/draft paths and the safety failures from the audit. Development tooling is upgraded with compatible Cloudflare types; Node 24.19.0 is pinned. The CI workflow validates only and contains no deployment step.

Additional local validation uses Wrangler/workerd with an isolated local D1 and synthetic login data. A Chromium interaction check was attempted with a local static fixture and every API mocked, but the installed browser did not complete even a minimal local data-page check. Browser interaction verification remains unconfirmed; dashboard syntax/ID checks and API regression tests pass. None of these checks establishes production credential readiness or a completed rollout.

The original audit is retained outside the checkout at `/workspace/audit-upwork/AUDIT.md`; validation artifacts there describe the current cloud session. No real Upwork confirmation, live Loom mutation, external email delivery or live Apify task/schedule update is part of validation.
