import { answerQuestions, ClaudeConfigError, ClaudeDeclined, scoreJob, writeOpening, type JobForClaude } from '../claude';
import { acquireLease, releaseLease } from '../kv';
import { McpError, type McpClient } from '../mcp';
import { copyForJob, deleteVideos, loomCookie, markLoomError } from '../loom';
import { findKey, upworkClient } from '../oauth';
import { loadSettings, loadState, patchState, type Env, type Settings, type State } from '../settings';
import { cannotApply, CLOSED_REASON, connectsOverLimit, stripUntrusted } from './filters';
import { jobAnalysis } from './analysis';
import { assembleLetter, checkAnswers, checkLetter, checkOpening, computeBid, swapLoomLink, type Answer } from './letter';
import { createPreview, FIXED_DEFAULTS, type Preview } from './preview';
import { loadTrackRecord, profileForClaude, syncDue, syncTrackRecord, weightedScore, winsForClaude } from './profile';

// What Claude knows about Rafa for this run (built once per run from his Upwork track record, the letter and Siv's notes).
interface Who { profile: string; wins: string }

// Writer (M4): takes jobs that passed the filters ('matched'), re-checks them on Upwork, scores them with Claude,
// writes the opening paragraph into Siv's template, reads screening questions from a preview (nothing is sent) and
// queues the proposal for review. Bounded to settings.maxNewJobsPerRun jobs per cron run.

const LEASE_MS = 10 * 60_000;

interface JobRow {
  id: string; title: string; url: string | null; job_type: string | null; budget: string | null; client_country: string | null;
  reason: string | null; posted_at: string | null; proposals_tier: string | null;
}
export interface WriteSummary { queued: number; lowScore: number; filtered: number; errors: number; note: string | null }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function invitedJobIds(client: McpClient, state: State): Promise<Set<string>> {
  const ids = new Set<string>();
  const tool = state.upwork.toolNames.list_freelancer_proposals;
  if (!tool || !state.upwork.orgUid) return ids;
  const r = await client.callTool(tool, { action: 'invitations', org_uid: state.upwork.orgUid, params: { status: 'pending', limit: 10 } });
  const list = findKey(r, 'invitations') ?? findKey(r, 'items');
  for (const inv of Array.isArray(list) ? list : []) {
    const jp = findKey(inv, 'jobPosting') as { id?: unknown } | undefined;
    if (jp?.id !== undefined) ids.add(String(jp.id));
  }
  return ids;
}

interface Details { description: string; connectsCost: number | null; connectsBalance: number | null; canApply: boolean | null; applied: boolean }
export async function jobDetails(client: McpClient, state: State, id: string): Promise<Details> {
  const r = await client.callTool(state.upwork.toolNames.find_jobs, { action: 'get', org_uid: state.upwork.orgUid, params: { id } }) as Record<string, unknown>;
  const posting = findKey(r, 'marketplaceJobPosting') as { content?: { description?: string } } | undefined;
  const description = stripUntrusted(posting?.content?.description ?? (findKey(r, 'description') as string | undefined) ?? '');
  const cost = Number(findKey(r, 'connects_cost'));
  const balance = Number(findKey(r, 'connects_balance'));
  const can = findKey(r, 'can_apply');
  return {
    description, connectsCost: Number.isFinite(cost) ? cost : null, connectsBalance: Number.isFinite(balance) ? balance : null,
    canApply: typeof can === 'boolean' ? can : null, applied: findKey(r, 'applied') === true,
  };
}

interface Scores { score: number; win: number | null; profile: number }
async function setJob(env: Env, id: string, status: string, reason: string, sc: Scores | null = null) {
  await env.DB.prepare(
    'UPDATE jobs SET status = ?, reason = ?, score = COALESCE(?, score), win_score = COALESCE(?, win_score), profile_score = COALESCE(?, profile_score) WHERE id = ?',
  ).bind(status, reason.slice(0, 400), sc?.score ?? null, sc?.win ?? null, sc?.profile ?? null, id).run();
}

type Outcome = 'queued' | 'lowScore' | 'filtered' | 'errors';

async function processJob(env: Env, client: McpClient, state: State, s: Settings, who: Who, job: JobRow, invited: Set<string>): Promise<Outcome> {
  if (invited.has(job.id)) { await setJob(env, job.id, 'filtered', 'Invited: answer the invitation on Upwork'); return 'filtered'; }
  const d = await jobDetails(client, state, job.id);
  if (d.applied) { await setJob(env, job.id, 'filtered', 'Already applied'); return 'filtered'; }
  const blocked = cannotApply(d.canApply, d.connectsCost, d.connectsBalance);
  if (blocked === 'closed') { await setJob(env, job.id, 'filtered', CLOSED_REASON); return 'filtered'; }
  // blocked === 'connects': write it anyway; it waits in the queue until Connects are added.
  const overLimit = connectsOverLimit(d.connectsCost, s);
  if (overLimit) { await setJob(env, job.id, 'filtered', overLimit); return 'filtered'; }

  const forClaude: JobForClaude = {
    title: stripUntrusted(job.title), jobType: job.job_type, budget: job.budget, country: job.client_country,
    description: d.description || '(no description returned)', clientFeedbackNames: [],
  };
  const { profileFit, winSimilarity, reason: why, pros, cons } = await scoreJob(env, who.profile, who.wins, forClaude);
  const keywords = (job.reason ?? '').startsWith('Matched: ') ? job.reason!.slice(9).split(', ').filter(Boolean) : [];
  const analysis = JSON.stringify(jobAnalysis({
    title: job.title, keywords, proposalsTier: job.proposals_tier, postedAt: job.posted_at, jobType: job.job_type,
    budget: job.budget, connectsCost: d.connectsCost, winScore: winSimilarity, profileScore: profileFit,
  }, { pros, cons }));
  await env.DB.prepare('UPDATE jobs SET analysis = ? WHERE id = ?').bind(analysis, job.id).run();
  const score = weightedScore(profileFit, winSimilarity, s);
  const breakdown = winSimilarity === null ? `profile ${profileFit}, no past wins yet` : `past wins ${winSimilarity} · profile ${profileFit}`;
  const scoreText = `Score ${score} (${breakdown}): ${why}`.slice(0, 400);
  const sc: Scores = { score, win: winSimilarity, profile: profileFit };
  if (score < s.minScore) { await setJob(env, job.id, 'low_score', scoreText, sc); return 'lowScore'; }

  // Rafa's $/hr on Upwork is deliberately not used (Celia, Oct 22): only the rate set in Settings.
  const bid = computeBid(job.job_type, job.budget, s);
  if (bid === null) {
    await setJob(env, job.id, 'error', `No bid amount: the job lists no rate. Set Rafa's hourly rate in Settings → Bids.`, sc); return 'errors';
  }

  const sourceUrl = s.loom.sourceUrl || null; // the letter is checked and previewed with the source video; the copy goes in last
  const disclosure = s.disclosure.enabled ? s.disclosure.line : null;
  let opening = await writeOpening(env, who.profile, who.wins, s.letter.template, s.letter.rules, forClaude);
  let problem = checkOpening(opening) ?? checkLetter(assembleLetter(s.letter.template, opening, sourceUrl, disclosure), sourceUrl);
  if (problem) {
    opening = await writeOpening(env, who.profile, who.wins, s.letter.template, s.letter.rules, forClaude, problem);
    problem = checkOpening(opening) ?? checkLetter(assembleLetter(s.letter.template, opening, sourceUrl, disclosure), sourceUrl);
  }
  if (problem) { await setJob(env, job.id, 'error', `Letter rejected twice: ${problem}`, sc); return 'errors'; }
  let letter = assembleLetter(s.letter.template, opening, sourceUrl, disclosure);

  const fixed = job.job_type === 'fixed';
  let p: Preview | null = null;
  let note: string | null = blocked === 'connects' ? `Not enough Connects yet: balance ${d.connectsBalance}, this job costs ${d.connectsCost}` : null;
  try { p = await createPreview(client, state, { jobId: job.id, letter, bid, fixed }); } catch (e) { note = [note, `Preview not checked: ${errText(e)}`].filter(Boolean).join(' · '); }

  let answers: Answer[] = [];
  if (p?.questions.length) {
    answers = await answerQuestions(env, who.profile, forClaude, p.questions);
    let bad = checkAnswers(p.questions, answers);
    if (bad) { answers = await answerQuestions(env, who.profile, forClaude, p.questions, bad); bad = checkAnswers(p.questions, answers); }
    if (bad) { await setJob(env, job.id, 'error', `Screening answers rejected twice: ${bad}`, sc); return 'errors'; }
  }

  // The job's own Loom copy, named after the job (M5). Made last so a job dropped above leaves no copy behind.
  // On failure the letter keeps the source video and the card says why.
  let loomUrl = sourceUrl;
  let loomId: string | null = null;
  if (sourceUrl && state.loom.connected) {
    try {
      const copy = await copyForJob(env, sourceUrl, stripUntrusted(job.title));
      if (copy) { loomUrl = copy.url; loomId = copy.id; letter = swapLoomLink(letter, copy.url); }
    } catch (e) {
      await markLoomError(env, e);
      note = [note, `Loom copy failed, the letter uses the source video: ${errText(e)}`].filter(Boolean).join(' · ');
    }
  }

  const createParams = { charged_amount: bid, ...(p?.extra ?? (fixed ? FIXED_DEFAULTS : {})), ...(answers.length ? { answers } : {}) };
  // Auto mode approves straight away; fixed-price stays in review until Siv acknowledges Upwork's terms (Settings).
  const status = state.mode === 'auto' && (!fixed || s.fixedPriceTermsAcknowledged) ? 'approved' : 'pending';
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO proposals (job_id, title, url, job_type, budget, client_country, keywords, cover_letter, bid, create_params, loom_url, loom_video_id, connects, score, win_score, profile_score, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(job.id, stripUntrusted(job.title), job.url, job.job_type, job.budget, job.client_country, JSON.stringify(keywords), letter, bid,
      JSON.stringify(createParams), loomUrl, loomId, p?.connectsCost ?? d.connectsCost, score, winSimilarity, profileFit, status, note),
    env.DB.prepare("UPDATE jobs SET status = 'proposed', reason = ?, score = ?, win_score = ?, profile_score = ? WHERE id = ?").bind(scoreText, score, winSimilarity, profileFit, job.id),
  ]);
  // A proposal for this job already existed: the new copy is not used by anything.
  if (loomId && !inserted.meta.changes) {
    const cookie = await loomCookie(env);
    if (cookie) await deleteVideos(cookie, [loomId]).catch((e) => console.error('loom: unused copy not deleted', loomId, errText(e)));
  }
  return 'queued';
}

export async function runWriter(env: Env): Promise<WriteSummary | null> {
  const [state, s] = await Promise.all([loadState(env), loadSettings(env)]);
  if (state.paused || !state.upwork.connected || !state.upwork.orgUid || !state.upwork.toolNames.find_jobs) return null;
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'matched'").first<{ n: number }>();
  if (!pending?.n) return null;

  const summary: WriteSummary = { queued: 0, lowScore: 0, filtered: 0, errors: 0, note: null };
  if (!env.ANTHROPIC_API_KEY) summary.note = 'Waiting for the ANTHROPIC_API_KEY secret in Cloudflare.';
  else if (!s.letter.template.trim()) summary.note = 'Waiting for the letter template in Settings → Cover letter.';
  if (summary.note) { await record(env, summary); return summary; }
  if (!(await acquireLease(env, 'write', LEASE_MS))) return null;

  try {
    const { results: jobs } = await env.DB.prepare(
      "SELECT id, title, url, job_type, budget, client_country, reason, posted_at, proposals_tier FROM jobs WHERE status = 'matched' ORDER BY posted_at DESC, seen_at DESC LIMIT ?",
    ).bind(s.maxNewJobsPerRun).all<JobRow>();
    // Every other day, refresh Rafa's track record first; on failure keep the last one.
    let record = await loadTrackRecord(env);
    if (syncDue(state.trackRecordSyncedAt)) {
      record = await syncTrackRecord(env).catch((e) => { console.error('track record sync failed', errText(e)); summary.note = `Upwork profile not refreshed: ${errText(e)}`; return record; });
    }
    const who: Who = { profile: profileForClaude(record, s), wins: winsForClaude(record) };
    const client = await upworkClient(env);
    const invited = await invitedJobIds(client, state).catch(() => new Set<string>());
    for (const job of jobs) {
      try {
        summary[await processJob(env, client, state, s, who, job, invited)]++;
      } catch (e) {
        if (e instanceof ClaudeConfigError) { summary.note = e.message; break; } // the job stays 'matched' for the next run
        summary.errors++;
        const msg = errText(e);
        console.error('writer: job failed', job.id, msg);
        await setJob(env, job.id, 'error', e instanceof ClaudeDeclined ? msg : `Could not prepare: ${msg}`);
        if (e instanceof McpError && /\b429\b|rate.?limit|too many requests/i.test(msg)) {
          await patchState(env, { paused: true, pausedReason: `Upwork rate limit while preparing proposals: ${msg.slice(0, 200)}` });
          break;
        }
      }
    }
  } catch (e) {
    summary.errors++; summary.note = errText(e);
    console.error('writer failed', summary.note);
  } finally {
    await record(env, summary);
    await releaseLease(env, 'write');
  }
  return summary;
}

// Adds the writer's numbers to the latest run row and the dashboard's last-run line.
async function record(env: Env, w: WriteSummary) {
  const note = w.note ? `Writer: ${w.note}` : null;
  await env.DB.prepare(
    `UPDATE runs SET queued = COALESCE(queued, 0) + ?, errors = COALESCE(errors, 0) + ?,
       note = CASE WHEN ? IS NULL THEN note WHEN note IS NULL THEN ? ELSE note || ' · ' || ? END
     WHERE id = (SELECT MAX(id) FROM runs)`,
  ).bind(w.queued, w.errors, note, note, note).run();
  const st = await loadState(env);
  if (st.lastRun) {
    await patchState(env, {
      lastRun: {
        ...st.lastRun, queued: (st.lastRun.queued ?? 0) + w.queued, errors: st.lastRun.errors + w.errors,
        note: note ? (st.lastRun.note ? `${st.lastRun.note} · ${note}` : note) : st.lastRun.note,
      },
    });
  }
}
