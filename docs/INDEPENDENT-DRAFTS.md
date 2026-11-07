# Independent Apify drafts

This change adds an off-by-default draft path. It does not replace the :00/:30 Upwork searches, does not add proposal or invitation sweeps, and does not remove any send-time Upwork call.

## Flag

`INDEPENDENT_DRAFTS` is read from the Worker environment.

- Unset, empty, or any value other than `true`: the writer is unchanged. It still opens an Upwork client, reads the job, and creates a preview.
- `true`: matched jobs are drafted only from the saved public snapshot. The writer does not construct an Upwork client and does not call Upwork. Review drafts stay `pending`. Auto drafts are marked `approved` only so the existing sender can run. The sender still performs its live balance read, job read, invitation walk, preview, and single confirm before anything is submitted.

Rollback: remove the variable, or set it to anything other than `true`. Snapshot rows can stay. They are unused by the old writer. No Sending default, connection, credential, `TOKEN_KEY`, or D1 binding changes are part of this rollout. Do not change the Apify task, schedule, cursor, `clientId`, spending limit, or webhook to turn the flag on.

The flag is not in `wrangler.toml`, so a deploy does not switch it on.

## Migration

`schema.sql` adds `job_snapshots` with `CREATE TABLE IF NOT EXISTS`. The worker's existing startup schema step applies that statement. Existing tables and columns are not altered. This work did not run `npm run db:init` and did not write to remote D1.

The table stores:

- `job_id`: canonical digit string, including leading zeros. It is not stored as a number.
- `fetched_at`: when this app first stored the row.
- `source_posted_at` and `source_seen_at`: the feed's publication time and its own ingestion time. They are not rewritten to `fetched_at`.
- `raw_payload`: the feed object, cut at 100,000 characters when larger. A cut payload is valid JSON and includes `_truncated: true`.
- `normalized`: public fields only. `applied`, `canApply`, `connectsCost`, `connectsBalance`, `boost`, and `currency` are always null. A scraper `questions` value that is missing or `[]` stays unknown (`null`). A non-empty list is a hint, not a confirmed question list.

Apify drain writes the snapshot before it advances the receipt offset and before it clears the receipt item list. A replay merges into the same row. A partial or thin import cannot replace a description, question list, or raw payload that is already richer. A job that already has a proposal, or whose status is `proposed`, is not updated. The 30-jobs-per-hour intake cap is unchanged.

Claude prompts still receive at most 12,000 characters of the description. When that is shorter than the stored text, the prompt contains an explicit truncation line. The raw payload is not sent to Claude. Description newlines are kept in the snapshot.

After Claude and Loom finish, the draft is stored under `draft:ready:<job id>` before the proposal row is inserted. If that insert is interrupted, the next writer run inserts the saved draft and does not call Claude or Loom again. A question mismatch or a missing live question list sets the proposal back to `pending` and clears `approved_at` and `approved_via`, so Auto does not approve it again.

## What still calls Upwork

Counts are logical `tools/call`s in this client, not measured upstream requests and not a production savings figure. `K` is the live keyword count. `I` is invitation pages actually returned (1 to 10). `C` is 0 or 1 extra create when Upwork asks for payment or AI-interview fields. Happy-path figures use `C = 0`. Setup (`initialize`, `tools/list`, OAuth refresh, Check now), throttle retries, unknown reconciliation, stats, ledger, and profile sync are outside these rows.

| Event | Flag off | Flag on |
|---|---|---|
| One :00 or :30 search slot | `Q = min(12, K)` `find_jobs` searches. Unchanged. | Same. This PR does not replace discovery. |
| One writer run that drafts `M` jobs | `I` invitation pages + `M` job reads + `M` creates | **0** Upwork calls |
| Unboosted successful send | `5 + I` (balance, job read, invitation pages, create, confirm, balance) | Same |
| Boosted successful send | `6 + I` (one extra create carrying `boost_connects`) | Same |

A missing boost block, or an explicit "do not boost", still confirms the normal preview when the other send checks pass, and the reason is stored. `recommended_connects` is still used when `available` is omitted and the recommendation is a positive number. No send call was removed on the basis of an unverified schema.

If a live preview omits the screening-question list, the sender does not treat that as an empty list and does not confirm. The proposal returns to Review. If the live list differs from the stored answers, including hint answers from the feed, the proposal returns to Review and confirm is not called. An unclear confirm stays `unknown` and is not retried.

## Not in this change

- Replacing :00/:30 discovery with a proposal, invitation, or balance sweep.
- Any claim that a public snapshot proves the account can apply, has not applied, or has a Connects balance.
- Apify schedule, task input, cursor, `clientId`, the spending limit, or the webhook.
- Cookies, private Upwork endpoints, browser automation, or a new login.
