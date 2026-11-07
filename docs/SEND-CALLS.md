# Send-path Upwork calls

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
