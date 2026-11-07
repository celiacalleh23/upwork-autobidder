# Isolated branch preview

Production deploys use the top of `wrangler.toml` only: the `autobidder` D1 database, the production vars, the production crons, and the secrets already stored for `rafadataapp`. This change does not modify those.

Workers Builds previews do not inherit production vars or bindings. Wrangler 4.156 reads them from `[previews.vars]` and `[[previews.d1_databases]]`. The preview database is the empty database `rafadataapp-pr1-preview` (`c8aed43e-50cc-4d79-8f50-fee163b76763`). It is not the production database `77c7e7e7-0532-4a58-b61e-36161370a136`.

Do not put `[triggers]`, routes, or queue consumers under `previews`. Those settings target production. Do not add service, workflow, or queue-producer bindings. Do not copy `TOKEN_KEY`, Upwork, Apify, Claude, Loom, or email secrets into the preview. The preview secret list was not visible from this repo, so inheritance is treated as unknown. The Worker still refuses outbound work when `PREVIEW_ISOLATION` is exactly `true`.

Preview vars:

| Name | Value |
|---|---|
| `PREVIEW_ISOLATION` | `true` |
| `SCAN_ACCOUNT_DISABLED` | `true` |
| `CLAUDE_MODEL` | `preview-disabled` |
| `UPWORK_MCP_URL` | `https://invalid.example` |
| `INDEPENDENT_DRAFTS` | `false` |

Production does not set `PREVIEW_ISOLATION`. Unset means the normal Worker.

While the marker is true the Worker does not run scheduled discovery, writing, sending, imports, or upkeep. It rejects OAuth, webhooks, intake, and every non-read dashboard call. Upwork, Apify, Claude, Loom, and email functions throw before their network call.

## Database tables

`src/index.ts` applies `schema.sql` on the first request that needs the database (`ensureSchema`). On a preview that request uses only the preview binding, so the statements run against `rafadataapp-pr1-preview`. That is enough for an empty database. No production database command is required.

To create the tables before the first request, execute `schema.sql` against `rafadataapp-pr1-preview` only. Do not point that command at `autobidder`.
