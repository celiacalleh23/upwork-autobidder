# Upwork call accounting

These are logical MCP `tools/call` counts in this client. Each `upworkClient()` also sends one `initialize` and one `notifications/initialized` HTTP POST. Those are not included in the tool-call formulas. A throttle retry adds another `tools/call` for every tool except `confirm_preview`, which is never retried. Whether each logical call is one upstream request is not verified.

## Send

`I` is invitation pages actually returned (1 to 10). Happy path, no field retry.

| Path | Before the post-send removal | Now |
|---|---|---|
| Normal | `5 + I` | `4 + I` |
| Boosted | `6 + I` | `5 + I` |
| One invitation page | 6 and 7 | 5 and 6 |

The removed call is the balance read after confirm. The pre-send balance read, the job read, the invitation walk, the preview create, the boost create, and the single confirm stay. The header figure is marked stale. It is not a guessed balance and it is not used to decide the next spend.

A normal send cannot safely go below `4 + I` tool calls plus session setup. A boosted send cannot safely go below `5 + I` until a checked-in schema says one create can both learn `recommended_connects` and submit that bid.

## Search

Unset `UPWORK_DISCOVERY` keeps the :00 and :30 searches. `Q = min(12, K)` logical searches per slot, 48 slots per day, so `48 * Q` per day if every slot runs. The repo default keyword list has length 3, which is 144 searches per day. Live `K` is not in git. The code cap is 576. Setting `UPWORK_DISCOVERY` to `false` makes that 0 and leaves discovery to Apify, manual links, and intake. That is off until set. It can miss jobs the Upwork search would have found. Apify cadence, task input, and webhook are unchanged.

Public snapshots still must not be treated as `applied`, `canApply`, an invitation, a Connects balance, or a boost bid.

## Not enforced here

The category table (search 15/150/750, proposals 20/60/150, profile 5/75/250, other reads 20/250/750, other changes 4/15/40) is user-supplied. This code does not know which tool action belongs to which row, including `find_jobs get` versus search, preview create versus confirm, invitations, the dashboard, the ledger, and session setup. Search attempts already use the existing 15/minute, 150/hour, and 750/day reservation, separate for the bidding and scan connections. No single 15/minute and 150/hour cap was added across every call. Day windows (rolling, fixed, timezone) were not verified, so no new day cap was added.

`tools/list` for profile, contract, and ledger tools is cached for 24 hours after the first list. Sends do not use that cache.


Counts are logical `tools/call`s in this client for one successful send. `I` is the number of invitation pages returned (at least 1, at most 10). A field retry or a throttle retry adds a call and is not in the happy path. Confirm is never retried.

| Path | Before | After |
|---|---|---|
| Normal send, happy path | `5 + I` (balance, job read, `I` invitation pages, create, confirm, balance again) | `4 + I` |
| Boosted send, happy path | `6 + I` (the extra create carries `boost_connects`) | `5 + I` |
| One invitation page | normal 6, boosted 7 | normal 5, boosted 6 |

The removed call is the balance read after a successful confirm. That read only updated the header and the low-Connects alert. The next send still reads the balance before it decides to spend, and it does not use a subtracted estimate. The header keeps the pre-send figure and marks it stale until that fresh read, or until the existing upkeep refresh (at most one balance read each 30 minutes). The low-Connects email can wait until one of those reads.

Not removed:

- The job read on the send. The preview parser does not show whether Rafa already applied, and no checked-in schema says confirm re-checks that.
- The balance read before spending. A null balance still blocks the send.
- The invitation walk on that send. An earlier list can miss an invitation that arrives before confirm. There is only one walk per send, so there is no second walk to drop.
- The second create when boosting. The bid comes from the first preview. Nothing checked in says one create can both learn `recommended_connects` and submit that bid.
- Confirm, and the rule that an unclear confirm stays `unknown` and is not sent again.
