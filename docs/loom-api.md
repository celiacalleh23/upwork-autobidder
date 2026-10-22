# Loom internal API (M5)

Loom has no public API for copying videos. These are the requests loom.com itself sends. Celia captured them in
Chrome DevTools on Oct 22, 2026, sharing the Payload and Response only (no headers or cookies).

All calls are `POST https://www.loom.com/graphql` with the JSON body `{ operationName, variables, query }`. They are
authenticated by the browser session cookie (`connect.sid`), which is pasted in Settings → Loom and stored encrypted
in `kv['loom:session']`.

## Duplicate (copy and name in one step)

```json
{"operationName":"DuplicateVideo",
 "variables":{"videoId":"<source id>","newName":"<job title>","spaceId":null,"password":null},
 "query":"mutation DuplicateVideo($videoId: ID!, $newName: String!, $spaceId: ID, $password: String) { duplicateVideo(videoId: $videoId newName: $newName spaceId: $spaceId password: $password) { __typename ... on GenericError { __typename message } ... on DuplicateVideoPayload { __typename newVideo { __typename id name } } } }"}
```

Response: `{"data":{"duplicateVideo":{"__typename":"DuplicateVideoPayload","newVideo":{"__typename":"RegularUserVideo","id":"<new id>","name":"…"}}}}`

The copy's link is `https://www.loom.com/share/<new id>`. No separate rename call is needed.

## Delete

```json
{"operationName":"BulkDeleteVideos","variables":{"videoIds":["<id>"]},
 "query":"mutation BulkDeleteVideos($videoIds: [ID]!) { bulkDeleteVideos(videoIds: $videoIds) { ... on BulkDeleteVideosPayload { success __typename } __typename } }"}
```

Response: `{"data":{"bulkDeleteVideos":{"success":true,"__typename":"BulkDeleteVideosPayload"}}}`

## Errors

- A session that is not signed in gets HTTP 200 with `{"data":{"duplicateVideo":{"__typename":"UserNotAuthorizedError"}}}`.
  This was checked with a made-up cookie.
- Any `__typename` ending in `Error` is a failure. The `NotAuthorized` ones mean the session must be pasted again.
- Only the video's owner can duplicate it, so the source video must belong to the connected Loom account.

## How the tool uses it (`src/loom.ts`)

- **Connect:** makes one test copy of the source video and deletes it straight away.
- **Writer:** once the letter, preview and answers are accepted, it makes one copy named after the job. That copy's link
  replaces the source link in the letter. If the copy fails, the letter keeps the source video and the card says why.
- **Cleanup:** every 6 hours, from the 5-minute cron, it deletes copies older than `loom.deleteAfterDays`. It only
  touches ids stored in `proposals.loom_video_id`.
