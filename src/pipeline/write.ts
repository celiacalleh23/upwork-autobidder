import { finiteNumber } from './sendRules';
import { answerQuestions, ClaudeConfigError, ClaudeDeclined, scoreJob, writeOpening, type JobForClaude } from '../claude';
import { acquireLease, delKv, getKv, putKv, releaseLease, ownsLease, renewLease } from '../kv';
import { isAccountWarning, McpError, type McpClient } from '../mcp';
import { copyForJob, deleteCopy, LoomAuthError, markLoomError } from '../loom';
import { findKey, upworkClient } from '../oauth';
import { loadSettings, loadState, patchState, type Env, type Settings, type State } from '../settings';
import { cannotApply, CLOSED_REASON, connectsOverLimit, evaluateJob, stripUntrusted } from './filters';
import { jobAnalysis } from './analysis';
import { assembleLetter, checkAnswers, checkLetter, checkOpening, computeBid, swapLoomLink, type Answer } from './letter';
import { createPreview, FIXED_DEFAULTS, type Preview } from './preview';
import { isThrottle, noteThrottle, pauseForWarning, UpworkBusy, clearThrottle } from '../upworkPace';
import { loadTrackRecord, profileForClaude, weightedScore, winsForClaude } from './profile';

// What Claude knows about Rafa for this run (built once per run from her Upwork track record, the letter and Siv's notes).
interface Who { profile: string; wins: string }

// Writer (M4): takes jobs that passed the filters ('matched'), re-checks them on Upwork, scores them with Claude,
// writes the opening paragraph into Siv's template, reads screening questions from a preview (nothing is sent) and
// queues the proposal for review. Bounded to settings.maxNewJobsPerRun jobs per cron run.

// A job that stops the writer this many times is set aside as an error, so the jobs after it get written.
const MAX_TRIES = 3;

interface JobRow {
  id: string; title: string; url: string | null; job_type: string | null; budget: string | null; client_country: string | null;
  reason: string | null; posted_at: string | null; proposals_tier: string | null;
}
export interface WriteSummary { queued: number; lowScore: number; filtered: number; errors: number; note: string | null }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function invitedJobIds(client: McpClient, state: State): Promise<Set<string>> {
  const ids = new Set<string>();
  const tool = state.upwork.toolNames.list_freelancer_proposals;
  if (!tool || !state.upwork.orgUid) throw new McpError('Could not verify invitations: missing Upwork tool or account.');
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await client.callTool(tool, { action: 'invitations', org_uid: state.upwork.orgUid, params: { status: 'pending', limit: 10, ...(cursor ? { cursor } : {}) } });
    const list = findKey(r, 'invitations') ?? findKey(r, 'items');
    if (!Array.isArray(list)) throw new McpError('Could not read invitation results.');
    for (const inv of list) {
      const jp = findKey(inv, 'jobPosting') as { id?: unknown } | undefined;
      if (jp?.id !== undefined) ids.add(String(jp.id).replace(/^~02/, ''));
    }
    const info = findKey(r, 'pageInfo') as { hasNextPage?: boolean; endCursor?: string } | undefined;
    if (!info?.hasNextPage) return ids;
    if (!info.endCursor || info.endCursor === cursor) throw new McpError('Could not finish checking invitations.');
    cursor = info.endCursor;
  }
  throw new McpError('Invitation check exceeded its page limit; verify on Upwork.');
  return ids;
}

// What a job's own page says (find_jobs get: one job by id, not a search). Title, type, budget and country let the
// writer handle jobs added by link (jobs.ts). Shape seen Oct 30: data.marketplaceJobPosting.{content{title,
// description}, contractTerms{contractType, fixedPriceContractTerms.amount.rawValue, hourlyContractTerms},
// clientCompanyPublic.country.name}. Budget text matches the search results': "500.00", "20.00–45.00/hr".
interface Details {
  description: string; connectsCost: number | null; connectsBalance: number | null; canApply: boolean | null; applied: boolean;
  title: string | null; jobType: 'fixed' | 'hourly' | null; budget: string | null; country: string | null;
  verification: string | null; proposalCount: number | null; postedAt: string | null;
}
const money = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null; };
export function readJobPosting(r: unknown): Pick<Details, 'title' | 'jobType' | 'budget' | 'country'> {
  const posting = findKey(r, 'marketplaceJobPosting');
  const terms = findKey(posting, 'contractTerms');
  const type = String(findKey(terms, 'contractType') ?? '').toUpperCase();
  const jobType = type === 'FIXED' ? 'fixed' : type === 'HOURLY' ? 'hourly' : null;
  let budget: string | null = null;
  if (jobType === 'fixed') budget = money(findKey(findKey(findKey(terms, 'fixedPriceContractTerms'), 'amount'), 'rawValue'));
  if (jobType === 'hourly') {
    const h = findKey(terms, 'hourlyContractTerms');
    const min = money(findKey(h, 'hourlyBudgetMin')), max = money(findKey(h, 'hourlyBudgetMax'));
    budget = min && max ? `${min}–${max}/hr` : max ? `up to ${max}/hr` : min ? `${min}+/hr` : null;
  }
  const title = findKey(findKey(posting, 'content'), 'title');
  const country = findKey(findKey(findKey(posting, 'clientCompanyPublic'), 'country'), 'name');
  return {
    title: typeof title === 'string' ? stripUntrusted(title).slice(0, 300) || null : null, jobType, budget,
    country: typeof country === 'string' ? country.slice(0, 60) : null,
  };
}
export async function jobDetails(client: McpClient, state: State, id: string): Promise<Details> {
  const r = await client.callTool(state.upwork.toolNames.find_jobs, { action: 'get', org_uid: state.upwork.orgUid, params: { id } }) as Record<string, unknown>;
  const posting = findKey(r, 'marketplaceJobPosting') as { content?: { description?: string } } | undefined;
  const description = stripUntrusted(posting?.content?.description ?? (findKey(r, 'description') as string | undefined) ?? '');
  const cost = finiteNumber(findKey(r, 'connects_cost'));
  const balance = finiteNumber(findKey(r, 'connects_balance'));
  const can = findKey(r, 'can_apply');
  return {
    description, connectsCost: cost, connectsBalance: balance,
    verification: typeof findKey(r, 'verification_status') === 'string' ? String(findKey(r, 'verification_status')) : null,
    proposalCount: finiteNumber(findKey(r, 'proposal_count')),
    postedAt: postingDate(findKey(r, 'published_date') ?? findKey(r, 'publishedDateTime') ?? findKey(r, 'created_date')),
    canApply: typeof can === 'boolean' ? can : null, applied: findKey(r, 'applied') === true, ...readJobPosting(r),
  };
}

const postingDate = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

interface Scores { score: number; win: number | null; profile: number }
async function setJob(env: Env, id: string, status: string, reason: string, sc: Scores | null = null) {
  await env.DB.prepare(
    'UPDATE jobs SET status = ?, reason = ?, score = COALESCE(?, score), win_score = COALESCE(?, win_score), profile_score = COALESCE(?, profile_score) WHERE id = ?',
  ).bind(status, reason.slice(0, 400), sc?.score ?? null, sc?.win ?? null, sc?.profile ?? null, id).run();
}

type Outcome = 'queued' | 'lowScore' | 'filtered' | 'errors';

async function processJob(env: Env, client: McpClient, state: State, s: Settings, who: Who, job: JobRow, invited: Set<string>, lease: string): Promise<Outcome> {
  if (invited.has(job.id)) { await setJob(env, job.id, 'filtered', 'Invited: answer the invitation on Upwork'); return 'filtered'; }
  const d = await jobDetails(client, state, job.id);
  job = { ...job, title: d.title ?? job.title, job_type: d.jobType ?? job.job_type, budget: d.budget ?? job.budget, client_country: d.country ?? job.client_country, posted_at: d.postedAt ?? job.posted_at };
  await env.DB.prepare('UPDATE jobs SET title = ?, job_type = ?, budget = ?, client_country = ?, posted_at = ? WHERE id = ?')
    .bind(job.title, job.job_type, job.budget, job.client_country, job.posted_at, job.id).run();
  const verdict = evaluateJob({ id: job.id, title: job.title, description: d.description, job_type: job.job_type ?? undefined,
    budget: job.budget ?? undefined, client: { country: job.client_country ?? undefined, verification_status: d.verification ?? undefined },
    ...(d.proposalCount !== null ? { proposal_count: d.proposalCount } : {}), proposals_tier: job.proposals_tier ?? undefined, applied: d.applied }, s, invited);
  if (verdict.status === 'filtered') { await setJob(env, job.id, 'filtered', verdict.reason); return 'filtered'; }
  if (s.maxExistingProposals > 0 && d.proposalCount === null && !job.proposals_tier) {
    await setJob(env, job.id, 'error', 'Could not verify the current proposal count.'); return 'errors';
  }
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
  const keywords = verdict.keywords;
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
  // Settings → Personal sentence off: no Claude sentence, the letter is the template alone.
  const withOpening = s.letter.opening !== 'off';
  let opening = withOpening ? await writeOpening(env, who.profile, who.wins, s.letter.template, s.letter.rules, forClaude) : '';
  let problem = (withOpening ? checkOpening(opening) : null) ?? checkLetter(assembleLetter(s.letter.template, opening, sourceUrl, disclosure), sourceUrl);
  if (problem && withOpening) {
    opening = await writeOpening(env, who.profile, who.wins, s.letter.template, s.letter.rules, forClaude, problem);
    problem = checkOpening(opening) ?? checkLetter(assembleLetter(s.letter.template, opening, sourceUrl, disclosure), sourceUrl);
  }
  if (problem) { await setJob(env, job.id, 'error', `Letter rejected twice: ${problem}`, sc); return 'errors'; }
  let letter = assembleLetter(s.letter.template, opening, sourceUrl, disclosure);

  const fixed = job.job_type === 'fixed';
  let p: Preview | null = null;
  let note: string | null = blocked === 'connects' ? `Not enough Connects yet: balance ${d.connectsBalance}, this job costs ${d.connectsCost}` : null;
  p = await createPreview(client, state, { jobId: job.id, letter, bid, fixed });

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
      if (!(e instanceof LoomAuthError)) await markLoomError(env, e); // auth errors are recorded by the Loom module
      note = [note, `Loom copy failed, the letter uses the source video: ${errText(e)}`].filter(Boolean).join(' · ');
    }
  }

  const createParams = { charged_amount: bid, ...(p?.extra ?? (fixed ? FIXED_DEFAULTS : {})), ...(answers.length ? { answers } : {}) };
  // Auto mode approves straight away; fixed-price stays in review until Siv acknowledges Upwork's terms (Settings).
  const current = await loadState(env);
  if (!(await ownsLease(env, 'write', lease)) || current.paused || !current.upwork.connected || current.controlsVersion !== state.controlsVersion || JSON.stringify(await loadSettings(env)) !== JSON.stringify(s)) {
    if (loomId) await deleteCopy(env, loomId).catch(() => undefined);
    throw new McpError('Controls changed while preparing the proposal; retry after review.');
  }
  const status = current.mode === 'auto' && (!fixed || s.fixedPriceTermsAcknowledged) ? 'approved' : 'pending';
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO proposals (job_id, title, url, job_type, budget, client_country, keywords, cover_letter, bid, create_params, loom_url, loom_video_id, connects, score, win_score, profile_score, status, error, approved_at, approved_via)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(job.id, stripUntrusted(job.title), job.url, job.job_type, job.budget, job.client_country, JSON.stringify(keywords), letter, bid,
      JSON.stringify(createParams), loomUrl, loomId, p?.connectsCost ?? d.connectsCost, score, winSimilarity, profileFit, status, note,
      status === 'approved' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, status === 'approved' ? 'auto-submit' : null),
    env.DB.prepare("UPDATE jobs SET status = 'proposed', reason = ?, score = ?, win_score = ?, profile_score = ? WHERE id = ?").bind(scoreText, score, winSimilarity, profileFit, job.id),
  ]);
  // A proposal for this job already existed: the new copy is not used by anything.
  if (loomId && !inserted.meta.changes) await deleteCopy(env, loomId).catch((e) => console.error('loom: unused copy not deleted', loomId, errText(e)));
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
  let lease = await acquireLease(env, 'write', 20 * 60_000);
  if (!lease) return null;

  try {
    const { results: jobs } = await env.DB.prepare(
      "SELECT id, title, url, job_type, budget, client_country, reason, posted_at, proposals_tier FROM jobs WHERE status = 'matched' ORDER BY posted_at DESC, seen_at DESC LIMIT ?",
    ).bind(s.maxNewJobsPerRun).all<JobRow>();
    // Rafa's track record is refreshed by the upkeep run (index.ts), not here, to keep this run light.
    const record = await loadTrackRecord(env);
    await patchState(env, { writer: { startedAt: new Date().toISOString() } });
    const who: Who = { profile: profileForClaude(record, s), wins: winsForClaude(record) };
    const client = await upworkClient(env);
    const invited = await invitedJobIds(client, state);
    const deadline = Date.now() + 12 * 60_000;
    for (const job of jobs) {
      if (Date.now() >= deadline || !(await ownsLease(env, 'write', lease)) || (await loadState(env)).paused) break;
      const renewed = await renewLease(env, 'write', lease, 20 * 60_000);
      if (!renewed) break;
      lease = renewed;
      const tryKey = `writeTry:${job.id}`;
      const tries = Number(await getKv(env, tryKey) ?? 0) + 1;
      if (tries > MAX_TRIES) {
        summary.errors++;
        await setJob(env, job.id, 'error', `Could not prepare: the run stopped ${MAX_TRIES} times on this job (check Cloudflare logs)`);
        await delKv(env, tryKey);
        continue;
      }
      await putKv(env, tryKey, String(tries));
      try {
        summary[await processJob(env, client, state, s, who, job, invited, lease)]++;
        await delKv(env, tryKey);
        await clearThrottle(env);
      } catch (e) {
        await delKv(env, tryKey); // it finished, with an error: not a run that was cut short
        if (e instanceof UpworkBusy) { summary.note = e.message; break; }
        if (e instanceof ClaudeConfigError) { summary.note = e.message; break; } // the job stays 'matched' for the next run
        const msg = errText(e);
        console.error('writer: job failed', job.id, msg);
        // Upwork's per-minute limit, still there after waiting once (mcp.ts): the job stays matched for the next run;
        // only 3 rounds in a row pause bidding (Celia, Oct 29). Claude's own 429s are not this (the SDK retries them).
        if (e instanceof McpError && isThrottle(e)) {
          summary.note = 'Upwork asked to slow down; writing again next round.';
          await noteThrottle(env, 'writing proposals', msg);
          break;
        }
        summary.errors++;
        // An Upwork restriction or warning: pause everything; the job stays matched for after the resume.
        if (e instanceof McpError && isAccountWarning(msg)) {
          summary.note = 'Upwork restricted or warned the account; bidding is paused.';
          await pauseForWarning(env, 'preparing proposals', msg);
          break;
        }
        await setJob(env, job.id, 'error', e instanceof ClaudeDeclined ? msg : `Could not prepare: ${msg}`);
      }
    }
  } catch (e) {
    summary.errors++; summary.note = errText(e);
    console.error('writer failed', summary.note);
  } finally {
    try {
      await record(env, summary);
      const done = [summary.queued && `${summary.queued} written`, summary.lowScore && `${summary.lowScore} low score`, summary.filtered && `${summary.filtered} filtered`, summary.errors && `${summary.errors} errors`].filter(Boolean).join(', ');
      const st = await loadState(env);
      await patchState(env, { writer: { startedAt: st.writer.startedAt, finishedAt: new Date().toISOString(), note: [done || 'nothing to write', summary.note].filter(Boolean).join(' · ') } });
    } finally { await releaseLease(env, 'write', lease); }
  }
  return summary;
}

// Each invocation records its own telemetry rather than changing an unrelated previous run.
async function record(env: Env, w: WriteSummary) {
  const note = w.note ? `Writer: ${w.note}` : null;
  await env.DB.prepare("INSERT INTO runs (finished_at, queued, matched, errors, note) VALUES (datetime('now'), ?, ?, ?, ?)")
    .bind(w.queued, w.queued + w.lowScore, w.errors, note).run();
}
