# Upwork Auto-Bidder: guide for Siv

Dashboard: **https://upwork-autobidder.siv-4c9.workers.dev** (sign in with the dashboard password)

## What the tool does

Every 5 minutes, all day (every 2 minutes in Auto-submit):

1. **Finds** new Klaviyo jobs on Upwork from clients in the US, Canada and the UK.
2. **Scores** each one out of 100 for how well it fits Rafa's profile (the weights are in Settings → Which jobs to bid on).
3. **Writes** the proposal: your template word for word, plus a short personal intro (2–3 sentences) for each job.
4. **Makes a Loom copy** of your video for each proposal, named after the job.
5. **Waits for review** in the dashboard. It sends nothing until Sending is switched on.
6. **Sends** approved proposals one at a time, at least 5 minutes apart, from Rafa's account.

## The tabs

| Tab | What's there |
|---|---|
| **Proposals** | Today's numbers, the **Review queue** (proposals waiting for you) and **Jobs found**: every job the tool looked at and why it was kept or skipped |
| **Activity log** | Every proposal and what happened to it (waiting, approved, sent, failed, skipped). A pink **Boosted** label marks boosted proposals. **Export CSV** downloads it |
| **Rafa's account** | Rafa's Upwork numbers: proposals sent, viewed, hires, and **Connects spent on proposals, proposal boosts, Profile Boost and Availability Badge**, with the total in dollars. Pick a period (today, yesterday, last 7 / 30 / 90 days, 12 months or a custom range with the calendar) and press **Refresh from Upwork** (it reads every record, 10 at a time, so it can take a few seconds) |
| **Keyword trends** | Look up any keyword: how many new jobs a day, competition, budgets and the skills clients ask for; trending skills this week; keyword ideas from Claude |
| **Settings** | All the rules. Press **Save changes** at the bottom after changing anything |

Not sure what a number means? Click the small **i** next to it for a short explanation.

## Every day: the Review queue

Each card shows the job, the match score (e.g. **Match 56/100**), the Connects it costs, the bid, **Why it fits / Watch out**, and the full letter.

- **Approve:** it goes out in the next free slot (when Sending is on).
- **Edit:** change the letter or the bid, then **Save**.
- **Skip:** it won't be sent.
- Approved something by mistake? In **Activity log**, press **Undo** next to it before it's sent.

## Review first or Auto-submit

The switch is at the top of the page.

- **Review first** (current): every proposal waits for your approval.
- **Auto-submit:** proposals go out without approval. **Only you switch this on**, once you're happy with the quality. The tool never turns it on by itself.
- **Auto-submit is also faster:** it looks for jobs every 2 minutes instead of 5, sends each proposal as soon as it's written instead of waiting for the next round, and sends the newest job first instead of the highest score. Proposals still go out at least 5 minutes apart. Going back to Review first returns to the normal pace.
- If Upwork ever asks for a human check, the tool goes back to Review first and tells you.

## Sending on and off

**Settings → Sending → "Send approved proposals to Upwork".** When it's off, nothing goes out and proposals just wait.

For fixed-price jobs, Upwork shows its Dispute Assistance terms before every proposal. Until you tick that box in the same section, fixed-price proposals stay in the queue and are never sent automatically.

## Pause everything

**Pause all** (top right) stops searching and sending straight away. Press **Resume bidding** to restart.

The tool also pauses itself on any Upwork warning or limit. The reason shows in a red bar at the top.

## Connects

- Proposals use the Connects in **Rafa's own account**. The balance shows at the top of the page and updates every 30 minutes.
- Below **250**, you get an email to buy more. Sending continues while there are enough Connects for the next job.
- To buy more: Upwork → Rafa's account → **Connects**.
- **What the Connects went to:** Rafa's account tab → **Connects spent on**: proposals, proposal boosts, Profile Boost and Availability Badge, refunds subtracted, with the total. Below it, whether the badge and Profile Boost are on now. Profile Boost and the badge are switched on and off on upwork.com.

### Boosting strong matches

**Settings → Caps and guardrails → "Boost strong matches".** Off until you switch it on.

- When it's on, every proposal with a match score at or above your number (75 by default) is boosted: the tool bids the Connects Upwork recommends for a top spot on the client's list, usually just a few.
- It never bids more than your **max per job** (20 by default). If a top spot needs more, the proposal goes out without a boost.
- Upwork charges the boost only if the proposal lands in a paid spot (or the client opens it before the bidding closes).
- If someone outbids you in the seconds before sending, Upwork sends nothing; the tool tries again with the new price, and after two tries sends without a boost.
- Boost bids show next to the Connects in the Activity log ("8 + 3 boost") and in the daily email.

## Changing the rules (Settings)

| To change… | Go to |
|---|---|
| Keywords, client countries, excluded words, minimum match score | **Which jobs to bid on** |
| Notes about Rafa (skills, industries) | **Cover letter → Notes about Rafa** |
| The letter template | **Cover letter → Letter template**. Keep `{opening}` (where the personal intro goes) and `{loom_link}` (where the video link goes) |
| Bid for hourly and fixed-price jobs, Rafa's hourly rate | **Bids** |
| Source video, how long copies are kept | **Loom video** |
| Daily/hourly limits, hours, Connects alert | **Caps and guardrails** |
| Report email | **Reports and connections** |

Current rules: Klaviyo in the title or description · US, Canada, UK · minimum score 35 · hourly bid = top of the client's range, or $30/hr when there's no range · fixed price = the client's budget · 24/7, 5 minutes apart (Auto-submit: scans every 2 minutes, newest job first) · no daily limit · alert below 250 Connects · boost: off until switched on (75+ score, max 20 Connects per job).

## Reconnecting

### Upwork (rarely needed)

1. **Settings → Reports and connections → Reconnect.**
2. In the Upwork tab that opens, sign in with **Rafa's freelancer account** and press **Allow**.
3. You land on a page that "can't be reached". That's expected. Copy the **whole address** from the address bar (it starts with `http://127.0.0.1`).
4. Paste it in the dashboard box and press **Finish** (within 10 minutes).

### Loom (about once a month, if the session isn't renewed automatically)

You'll get an email a week before it expires, and the dashboard shows it in red.

1. Open **loom.com**, signed in to the Loom account that owns the video.
2. Press **F12** → **Application** → **Cookies** → `https://www.loom.com`.
3. Click the row **connect.sid**. Copy its **Value** and note the date in **Expires**.
4. Dashboard: **Settings → Loom video → Reconnect**. Paste the value, pick the date, press **Connect**.

**Never share the connect.sid value** with anyone, including in chats or screenshots. It works like a password for Loom.

If Loom is disconnected, nothing stops: proposals go out with the original video instead of their own copy.

## Emails you'll get

- **Connects low** (below 250).
- **Loom expires in 7 days** / **Loom disconnected**.
- **Daily report** at 3 pm California: what was sent, what's waiting and what failed.
- Emails need the **RESEND_API_KEY** in Cloudflare (Workers → upwork-autobidder → Settings → Variables and Secrets), added with type **Secret**.

## Keyword trends

Upwork doesn't share what people type into its search, so this tab reads open job posts instead.

- **Explore keywords:** type up to 5, separated by commas, and choose *In the job title* (like the bidder) or *Anywhere in the post*. For each one: about how many new jobs a day, the share with fewer than 10 proposals, the usual budget and rate, client countries, and the skills clients tag those jobs with. Click a skill to explore it.
- **Keyword ideas:** Claude reads those figures and Rafa's profile and suggests keywords for her core work, close to it, and different markets.
- **Trending skills:** the skills on every job the scanner saw this week against last week.
- To bid on a new keyword, add it in **Settings → Which jobs to bid on**.

## If something looks wrong

| You see | What to do |
|---|---|
| Red bar "Paused: …" | Read the reason. If it's an Upwork limit, wait an hour and press **Resume bidding** |
| "Upwork not connected" | Reconnect Upwork (above) |
| "Loom not connected" or a Loom error | Reconnect Loom (above) |
| A proposal marked **Check on Upwork** | The tool isn't sure it was sent. It checks by itself; it never sends it twice |
| A job you expected isn't in the queue | Look it up in **Jobs found**: the reason is next to it (country, score, already applied…) |
| The page looks old after an update | Reload with **Ctrl + Shift + R** (Mac: **Cmd + Shift + R**) |

## Safety rules built in

- Nothing is sent while **Sending** is off, and in **Review first** nothing is sent without your approval.
- **One proposal per job**, never twice.
- No email, phone or outside links in the personal intro. Only your template's links.
- Job posts are treated as text to read, never as instructions to follow.
- Passwords and sessions (Upwork, Loom, the Claude API key) are stored encrypted and never shown.
