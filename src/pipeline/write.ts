import { answerQuestions, ClaudeConfigError, ClaudeDeclined, scoreJob, writeOpening, type JobForClaude } from '../claude';
import { acquireLease, releaseLease } from '../kv';
import { McpError, type McpClient } from '../mcp';
import { findKey, upworkClient } from '../oauth';
import { loadSettings, loadState, patchState, type Env, type Settings, type State } from '../settings';
import { connectsOverLimit, stripUntrusted } from './filters';
import { assembleLetter, checkAnswers, checkLetter, checkOpening, computeBid, type Answer } from './letter';
import { loadTrackRecord, profileForClaude, syncDue, syncTrackRecord, weightedScore, winsForClaude } from './profile';

// What Claude knows about Rafa for this run (built once per run from his Upwork track record, the letter and Siv's notes).
interface Who { profile: string; wins: string; upworkRate: number | null }

// Writer (M4): takes jobs that passed the filters ('matched'), re-checks them on Upwork, scores them with Claude,
// writes the opening paragraph into Siv's template, reads screening questions from a preview (nothing is sent) and
// queues the proposal for review. Bounded to settings.maxNewJobsPerRun jobs per cron run.

const LEASE_MS = 10 * 60_000;

interface JobRow { id: string; title: string; url: string | null; job_type: string | null; budget: string | null; client_country: string | null; reason: string | null }
export interface WriteSummary { queued: number; lowScore: number; filtered: number; errors: number; note: string | null }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

async function invitedJobIds(client: McpClient, state: State): Promise<Set<string>> {
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

interface Details { description: string; connectsCost: number | null; canApply: boolean | null; applied: boolean }
async function jobDetails(client: McpClient, state: State, id: string): Promise<Details> {
  const r = await client.callTool(state.upwork.toolNames.find_jobs, { action: 'get', org_uid: state.upwork.orgUid, params: { id } }) as Record<string, unknown>;
  const posting = findKey(r, 'marketplaceJobPosting') as { content?: { description?: string } } | undefined;
  const description = stripUntrusted(posting?.content?.description ?? (findKey(r, 'description') as string | undefined) ?? '');
  const cost = Number(findKey(r, 'connects_cost'));
  const can = findKey(r, 'can_apply');
  return { description, connectsCost: Number.isFinite(cost) ? cost : null, canApply: typeof can === 'boolean' ? can : null, applied: findKey(r, 'applied') === true };
}

interface Preview { connectsCost: number | null; questions: string[]; extra: Record<string, string> }
// A preview has no side effects (BUILD_PLAN §4). The first call may ask for more fields; retry once with the defaults.
async function preview(client: McpClient, state: State, jobId: string, letter: string, bid: number, fixed: boolean): Promise<Preview> {
  const tool = state.upwork.toolNames.manage_proposals;
  if (!tool) throw new McpError('Upwork proposal tool is missing. Press Check now under Settings → Upwork.');
  const extra: Record<string, string> = fixed ? { payment_mode: 'by_project', estimated_duration: 'less_than_1_month' } : {};
  for (let attempt = 0; attempt < 2; attempt++) {
    const call = () => client.callTool(tool, { action: 'create', org_uid: state.upwork.orgUid, params: { job_reference: jobId, cover_letter: letter, charged_amount: bid, ...extra } });
    let r: unknown;
    try { r = await call(); } catch (e) {
      if (attempt === 0 && /application_method|ai.?interview/i.test(errText(e))) { extra.application_method = 'cover_letter'; continue; }
      if (attempt === 0 && /payment_mode|estimated_duration/i.test(errText(e))) { Object.assign(extra, { payment_mode: 'by_project', estimated_duration: 'less_than_1_month' }); continue; }
      throw e;
    }
    if (!findKey(r, 'preview_id')) {
      const asText = JSON.stringify(r ?? '');
      if (attempt === 0 && /application_method|ai.?interview/i.test(asText)) { extra.application_method = 'cover_letter'; continue; }
      throw new McpError(`Upwork preview returned no preview id: ${asText.slice(0, 200)}`);
    }
    const raw = findKey(r, 'screening_questions') ?? findKey(r, 'questions');
    const questions = (Array.isArray(raw) ? raw : [])
      .map((q) => (typeof q === 'string' ? q : String((q as Record<string, unknown>)?.question ?? (q as Record<string, unknown>)?.text ?? '')))
      .map((q) => stripUntrusted(q)).filter(Boolean);
    const cost = Number(findKey(r, 'connects_cost'));
    return { connectsCost: Number.isFinite(cost) ? cost : null, questions, extra };
  }
  throw new McpError('Upwork preview kept asking for more details.');
}

async function setJob(env: Env, id: string, status: string, reason: string, score: number | null = null) {
  await env.DB.prepare('UPDATE jobs SET status = ?, reason = ?, score = COALESCE(?, score) WHERE id = ?').bind(status, reason.slice(0, 400), score, id).run();
}

type Outcome = 'queued' | 'lowScore' | 'filtered' | 'errors';

async function processJob(env: Env, client: McpClient, state: State, s: Settings, who: Who, job: JobRow, invited: Set<string>): Promise<Outcome> {
  if (invited.has(job.id)) { await setJob(env, job.id, 'filtered', 'Invited: answer the invitation on Upwork'); return 'filtered'; }
  const d = await jobDetails(client, state, job.id);
  if (d.applied) { await setJob(env, job.id, 'filtered', 'Already applied'); return 'filtered'; }
  if (d.canApply === false) { await setJob(env, job.id, 'filtered', 'Upwork says this job can no longer be applied to'); return 'filtered'; }
  const overLimit = connectsOverLimit(d.connectsCost, s);
  if (overLimit) { await setJob(env, job.id, 'filtered', overLimit); return 'filtered'; }

  const forClaude: JobForClaude = {
    title: stripUntrusted(job.title), jobType: job.job_type, budget: job.budget, country: job.client_country,
    description: d.description || '(no description returned)', clientFeedbackNames: [],
  };
  const { profileFit, winSimilarity, reason: why } = await scoreJob(env, who.profile, who.wins, forClaude);
  const score = weightedScore(profileFit, winSimilarity, s);
  const breakdown = winSimilarity === null ? `profile ${profileFit}, no past wins yet` : `past wins ${winSimilarity} · profile ${profileFit}`;
  const scoreText = `Score ${score} (${breakdown}): ${why}`.slice(0, 400);
  if (score < s.minScore) { await setJob(env, job.id, 'low_score', scoreText, score); return 'lowScore'; }

  // Rafa's Upwork rate stands in when Settings has none (used for hourly jobs that list no rate).
  const bid = computeBid(job.job_type, job.budget, s.bid.profileRate > 0 || !who.upworkRate ? s : { ...s, bid: { ...s.bid, profileRate: who.upworkRate } });
  if (bid === null) {
    await setJob(env, job.id, 'error', `No bid amount: the job lists no rate. Set Rafa's hourly rate in Settings → Bids.`, score); return 'errors';
  }

  const loomUrl = s.loom.sourceUrl || null; // M5 replaces this with the job's own Loom copy
  const disclosure = s.disclosure.enabled ? s.disclosure.line : null;
  let opening = await writeOpening(env, who.profile, who.wins, s.letter.template, s.letter.rules, forClaude);
  let problem = checkOpening(opening) ?? checkLetter(assembleLetter(s.letter.template, opening, loomUrl, disclosure), loomUrl);
  if (problem) {
    opening = await writeOpening(env, who.profile, who.wins, s.letter.template, s.letter.rules, forClaude, problem);
    problem = checkOpening(opening) ?? checkLetter(assembleLetter(s.letter.template, opening, loomUrl, disclosure), loomUrl);
  }
  if (problem) { await setJob(env, job.id, 'error', `Letter rejected twice: ${problem}`, score); return 'errors'; }
  const letter = assembleLetter(s.letter.template, opening, loomUrl, disclosure);

  const fixed = job.job_type === 'fixed';
  let p: Preview | null = null;
  let note: string | null = null;
  try { p = await preview(client, state, job.id, letter, bid, fixed); } catch (e) { note = `Preview not checked: ${errText(e)}`; }

  let answers: Answer[] = [];
  if (p?.questions.length) {
    answers = await answerQuestions(env, who.profile, forClaude, p.questions);
    let bad = checkAnswers(p.questions, answers);
    if (bad) { answers = await answerQuestions(env, who.profile, forClaude, p.questions, bad); bad = checkAnswers(p.questions, answers); }
    if (bad) { await setJob(env, job.id, 'error', `Screening answers rejected twice: ${bad}`, score); return 'errors'; }
  }

  const createParams = { charged_amount: bid, ...(p?.extra ?? (fixed ? { payment_mode: 'by_project', estimated_duration: 'less_than_1_month' } : {})), ...(answers.length ? { answers } : {}) };
  const keywords = (job.reason ?? '').startsWith('Matched: ') ? job.reason!.slice(9).split(', ').filter(Boolean) : [];
  // Auto mode approves straight away; fixed-price stays in review until Siv acknowledges Upwork's terms (M6).
  const status = state.mode === 'auto' && !fixed ? 'approved' : 'pending';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO proposals (job_id, title, url, job_type, budget, client_country, keywords, cover_letter, bid, create_params, loom_url, connects, score, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(job.id, stripUntrusted(job.title), job.url, job.job_type, job.budget, job.client_country, JSON.stringify(keywords), letter, bid,
      JSON.stringify(createParams), loomUrl, p?.connectsCost ?? d.connectsCost, score, status, note),
    env.DB.prepare("UPDATE jobs SET status = 'proposed', reason = ?, score = ? WHERE id = ?").bind(scoreText, score, job.id),
  ]);
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
      "SELECT id, title, url, job_type, budget, client_country, reason FROM jobs WHERE status = 'matched' ORDER BY posted_at DESC, seen_at DESC LIMIT ?",
    ).bind(s.maxNewJobsPerRun).all<JobRow>();
    // Every other day, refresh Rafa's track record first; on failure keep the last one.
    let record = await loadTrackRecord(env);
    if (syncDue(state.trackRecordSyncedAt)) {
      record = await syncTrackRecord(env).catch((e) => { console.error('track record sync failed', errText(e)); summary.note = `Upwork profile not refreshed: ${errText(e)}`; return record; });
    }
    const who: Who = { profile: profileForClaude(record, s), wins: winsForClaude(record), upworkRate: record?.hourlyRate ?? null };
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
