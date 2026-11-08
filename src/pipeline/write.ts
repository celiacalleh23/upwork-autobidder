import { finiteNumber } from './sendRules';
import { answerQuestions, ClaudeConfigError, ClaudeDeclined, scoreJob, writeOpening, type JobForClaude } from '../claude';
import { acquireLease, delKv, getKv, putKv, releaseLease, ownsLease, renewLease } from '../kv';
import { isAccountWarning, McpError, McpJobAccessError, type McpClient } from '../mcp';
import { copyForJob, deleteCopy, LoomAuthError, markLoomError } from '../loom';
import { findKey, upworkClient } from '../oauth';
import { independentDrafts, loadSettings, loadState, patchState, type Env, type Settings, type State } from '../settings';
import { cannotApply, CLOSED_REASON, connectsOverLimit, evaluateJob, stripUntrusted } from './filters';
import { jobAnalysis } from './analysis';
import { assembleLetter, checkAnswers, checkLetter, checkOpening, computeBid, fallbackTitleOpening, metaLanguageIn, swapLoomLink, titleOnlyOpeningProblem, type Answer } from './letter';
import { createPreview, FIXED_DEFAULTS } from './preview';
import { isThrottle, noteThrottle, pauseForWarning, UpworkBusy, clearThrottle, permitJobRead } from '../upworkPace';
import { loadTrackRecord, profileForClaude, weightedScore, winsForClaude } from './profile';
import { BIDDER_HOURLY_USD, draftBid, draftReviewNote, heldReasonCanDraft, loadSnapshot, snapshotHoldReason, submissionGaps, type DraftBasis, type SubmissionGap } from './snapshot';

// What Claude knows about Rafa for this run (built once per run from her Upwork track record, the letter and Siv's notes).
interface Who { profile: string; wins: string }

// Writer (M4): takes jobs that passed the filters ('matched'), re-checks them on Upwork, scores them with Claude,
// writes the opening paragraph into Siv's template, reads screening questions from a preview (nothing is sent) and
// queues the proposal for review. Bounded to settings.maxNewJobsPerRun jobs per cron run.

// A job that stops the writer this many times is set aside as an error, so the jobs after it get written.
const MAX_TRIES = 3;

interface JobRow {
  id: string; title: string; url: string | null; job_type: string | null; budget: string | null; client_country: string | null;
  reason: string | null; posted_at: string | null; proposals_tier: string | null; status?: string;
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
  let note: string | null = blocked === 'connects' ? `Not enough Connects yet: balance ${d.connectsBalance}, this job costs ${d.connectsCost}` : null;
  const preview = await createPreview(client, state, { jobId: job.id, letter, bid, fixed });

  let answers: Answer[] = [];
  const liveQuestions = preview.questions;
  if (liveQuestions?.length) {
    answers = await answerQuestions(env, who.profile, forClaude, liveQuestions);
    let bad = checkAnswers(liveQuestions, answers);
    if (bad) { answers = await answerQuestions(env, who.profile, forClaude, liveQuestions, bad); bad = checkAnswers(liveQuestions, answers); }
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

  const createParams = {
    charged_amount: bid, ...(preview.extra ?? (fixed ? FIXED_DEFAULTS : {})),
    questions_state: liveQuestions === null ? 'unknown' : 'live',
    ...(answers.length ? { answers } : {}),
  };
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
      JSON.stringify(createParams), loomUrl, loomId, preview.connectsCost ?? d.connectsCost, score, winSimilarity, profileFit, status, note,
      status === 'approved' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, status === 'approved' ? 'auto-submit' : null),
    env.DB.prepare("UPDATE jobs SET status = 'proposed', reason = ?, score = ?, win_score = ?, profile_score = ? WHERE id = ?").bind(scoreText, score, winSimilarity, profileFit, job.id),
  ]);
  // A proposal for this job already existed: the new copy is not used by anything.
  if (loomId && !inserted.meta.changes) await deleteCopy(env, loomId).catch((e) => console.error('loom: unused copy not deleted', loomId, errText(e)));
  return 'queued';
}

export const draftReadyKey = (jobId: string) => `draft:ready:${jobId}`;

interface ReadyDraft {
  v: 1;
  letter: string;
  bid: number | null;
  score: number;
  win: number | null;
  profile: number;
  scoreText: string;
  analysis: string;
  keywords: string[];
  answers: Answer[];
  questionsState: 'hints' | 'unknown';
  note: string;
  loomUrl: string | null;
  loomId: string | null;
  title: string;
  url: string | null;
  jobType: string | null;
  budget: string | null;
  country: string | null;
  proposalsTier: string | null;
  bidBasis: DraftBasis;
  missing: SubmissionGap[];
}

async function loadReadyDraft(env: Env, jobId: string): Promise<ReadyDraft | null> {
  const raw = await getKv(env, draftReadyKey(jobId));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as ReadyDraft;
    if (d?.v !== 1 || typeof d.letter !== 'string' || (typeof d.bid !== 'number' && d.bid !== null) || typeof d.score !== 'number' || !Array.isArray(d.missing)) return null;
    return d;
  } catch { return null; }
}

async function draftFromSnapshot(env: Env, state: State, s: Settings, who: Who, job: JobRow, lease: string): Promise<Outcome> {
  // A committed proposal is not generated again. This also heals a job left matched after the insert landed.
  if (await env.DB.prepare('SELECT 1 AS n FROM proposals WHERE job_id = ?').bind(job.id).first()) {
    await env.DB.prepare("UPDATE jobs SET status = 'proposed' WHERE id = ? AND status = 'matched'").bind(job.id).run();
    return 'queued';
  }
  const snap = await loadSnapshot(env, job.id);
  if (!snap) { await setJob(env, job.id, 'error', 'Held: no saved public snapshot. Independent drafts do not call Upwork.'); return 'errors'; }
  const n = snap.normalized;
  const stored = await env.DB.prepare('SELECT normalized FROM job_snapshots WHERE job_id = ?').bind(job.id).first<{ normalized: string }>();
  const storedFault = stored ? (JSON.parse(stored.normalized) as { budgetFault?: string | null }).budgetFault : null;
  if (storedFault === 'malformed' && n.budgetFault === null) {
    await env.DB.prepare('UPDATE job_snapshots SET normalized = ? WHERE job_id = ?').bind(JSON.stringify(n), job.id).run();
  }
  const hold = snapshotHoldReason(n, s);
  if (hold) { await setJob(env, job.id, 'error', hold); return 'errors'; }
  job = {
    ...job, title: n.title ?? job.title, job_type: n.jobType ?? job.job_type, budget: n.budgetText ?? job.budget,
    client_country: n.country ?? job.client_country, posted_at: n.postedAt ?? job.posted_at, proposals_tier: n.proposalsTier ?? job.proposals_tier,
  };
  await env.DB.prepare('UPDATE jobs SET title = ?, job_type = ?, budget = ?, client_country = ?, posted_at = ?, proposals_tier = ? WHERE id = ?')
    .bind(job.title, job.job_type, job.budget, job.client_country, job.posted_at, job.proposals_tier, job.id).run();
  // Public fields only. applied is omitted, so a feed cannot assert that Rafa has not applied.
  const verdict = evaluateJob({
    id: job.id, title: job.title ?? '', description: n.description ?? '', job_type: job.job_type ?? undefined,
    budget: job.budget ?? undefined, client: { country: job.client_country ?? undefined, verification_status: n.verification ?? undefined },
    ...(n.proposalCount !== null ? { proposal_count: n.proposalCount } : {}), proposals_tier: job.proposals_tier ?? undefined,
  }, s, new Set(), { allowMissingVerification: true });
  if (verdict.status === 'filtered') { await setJob(env, job.id, 'filtered', verdict.reason); return 'filtered'; }
  let ready = await loadReadyDraft(env, job.id);
  if (!ready) {
    const priced = draftBid(n, s);
    const missing = submissionGaps(n, s);
    const forClaude: JobForClaude = {
      title: stripUntrusted(job.title), jobType: job.job_type, budget: job.budget, country: job.client_country,
      description: n.description ?? '', descriptionTruncated: n.descriptionTruncated, descriptionFragment: n.descriptionKind === 'fragment', clientFeedbackNames: [],
      clientHourlyUnstated: priced.basis === 'bidder-hourly-usd', bidderHourlyUsd: priced.basis === 'bidder-hourly-usd' ? BIDDER_HOURLY_USD : undefined,
    };
    const { profileFit, winSimilarity, reason: why, pros, cons } = await scoreJob(env, who.profile, who.wins, forClaude);
    const keywords = verdict.keywords;
    const analysis = JSON.stringify(jobAnalysis({
      title: job.title, keywords, proposalsTier: job.proposals_tier, postedAt: job.posted_at, jobType: job.job_type,
      budget: job.budget, connectsCost: null, winScore: winSimilarity, profileScore: profileFit,
    }, { pros, cons }));
    const score = weightedScore(profileFit, winSimilarity, s);
    const breakdown = winSimilarity === null ? `profile ${profileFit}, no past wins yet` : `past wins ${winSimilarity} · profile ${profileFit}`;
    const scoreText = `Score ${score} (${breakdown}): ${why}`.slice(0, 400);
    const sc: Scores = { score, win: winSimilarity, profile: profileFit };
    if (score < s.minScore) { await setJob(env, job.id, 'low_score', scoreText, sc); await env.DB.prepare('UPDATE jobs SET analysis = ? WHERE id = ?').bind(analysis, job.id).run(); return 'lowScore'; }
    const bid = priced.amount;
    const sourceUrl = s.loom.sourceUrl || null;
    const disclosure = s.disclosure.enabled ? s.disclosure.line : null;
    const withOpening = s.letter.opening !== 'off';
    const titleOnly = !n.description;
    const openingProblem = (text: string) => titleOnly ? titleOnlyOpeningProblem(text, job.title ?? '') : checkOpening(text);
    let opening = withOpening ? await writeOpening(env, who.profile, who.wins, s.letter.template, s.letter.rules, forClaude) : '';
    let problem = (withOpening ? openingProblem(opening) : null) ?? checkLetter(assembleLetter(s.letter.template, opening, sourceUrl, disclosure), sourceUrl);
    if (problem && withOpening) {
      opening = await writeOpening(env, who.profile, who.wins, s.letter.template, s.letter.rules, forClaude, problem);
      problem = openingProblem(opening) ?? checkLetter(assembleLetter(s.letter.template, opening, sourceUrl, disclosure), sourceUrl);
    }
    if (problem && titleOnly && withOpening) {
      opening = fallbackTitleOpening(job.title ?? '');
      problem = openingProblem(opening) ?? checkLetter(assembleLetter(s.letter.template, opening, sourceUrl, disclosure), sourceUrl);
    }
    if (problem) { await setJob(env, job.id, 'error', `Letter rejected twice: ${problem}`, sc); return 'errors'; }
    const hints = n.questions;
    let answers: Answer[] = [];
    if (hints?.length) {
      answers = await answerQuestions(env, who.profile, forClaude, hints);
      let bad = checkAnswers(hints, answers);
      if (bad) { answers = await answerQuestions(env, who.profile, forClaude, hints, bad); bad = checkAnswers(hints, answers); }
      if (bad) { await setJob(env, job.id, 'error', `Screening answers rejected twice: ${bad}`, sc); return 'errors'; }
    }
    let note = draftReviewNote('Saved from the public snapshot. Applied status, Connects, balance, boost, and final screening questions are checked on Upwork before anything is sent.', missing, priced.basis);
    if (!hints) note += ' Feed screening questions were missing or empty, so they stay unknown.';
    else note += ' Feed screening questions are hints until the live preview confirms them.';
    if (n.questionHint) note += ' An AI hint from the feed was stored and was not used as a question.';
    ready = {
      v: 1, letter: assembleLetter(s.letter.template, opening, sourceUrl, disclosure), bid, score, win: winSimilarity, profile: profileFit,
      scoreText, analysis, keywords, answers, questionsState: hints?.length ? 'hints' : 'unknown', note,
      loomUrl: sourceUrl, loomId: null, title: stripUntrusted(job.title), url: job.url, jobType: job.job_type, budget: job.budget,
      country: job.client_country, proposalsTier: job.proposals_tier, bidBasis: priced.basis, missing,
    };
    // Durable before the queue insert, so a crash after Claude does not call Claude or Loom again.
    await putKv(env, draftReadyKey(job.id), JSON.stringify(ready));
  }
  if (ready.score < s.minScore) { await setJob(env, job.id, 'low_score', ready.scoreText, { score: ready.score, win: ready.win, profile: ready.profile }); return 'lowScore'; }
  if (!ready.loomId && ready.loomUrl && state.loom.connected) {
    try {
      const copy = await copyForJob(env, ready.loomUrl, ready.title);
      if (copy) {
        ready.loomId = copy.id;
        ready.letter = swapLoomLink(ready.letter, copy.url);
        ready.loomUrl = copy.url;
        await putKv(env, draftReadyKey(job.id), JSON.stringify(ready));
      }
    } catch (e) {
      if (!(e instanceof LoomAuthError)) await markLoomError(env, e);
      ready.note = [ready.note, `Loom copy failed, the letter uses the source video: ${errText(e)}`].filter(Boolean).join(' · ');
      await putKv(env, draftReadyKey(job.id), JSON.stringify(ready));
    }
  }
  const fixed = ready.jobType === 'fixed';
  const createParams = {
    ...(ready.bid !== null ? { charged_amount: ready.bid } : {}),
    bid_basis: ready.bidBasis, missing: ready.missing,
    ...(ready.bidBasis === 'bidder-hourly-usd' ? { bidder_hourly_usd: BIDDER_HOURLY_USD } : {}),
    ...(fixed && ready.bidBasis === 'client' ? FIXED_DEFAULTS : {}),
    questions_state: ready.questionsState,
    ...(ready.answers.length ? { answers: ready.answers } : {}),
  };
  const current = await loadState(env);
  if (!(await ownsLease(env, 'write', lease)) || current.paused || current.controlsVersion !== state.controlsVersion || JSON.stringify(await loadSettings(env)) !== JSON.stringify(s)) {
    if (ready.loomId) await deleteCopy(env, ready.loomId).catch(() => undefined);
    await delKv(env, draftReadyKey(job.id));
    throw new McpError('Controls changed while preparing the proposal; retry after review.');
  }
  // Review stays pending. Auto approves a future draft, including one with blank source fields.
  // A fixed-price job with no amount stays pending. Internal wording stays pending.
  const meta = metaLanguageIn(ready.letter);
  const fixedWithoutAmount = fixed && ready.bid === null;
  const status = !meta && !fixedWithoutAmount && current.mode === 'auto' && (!fixed || s.fixedPriceTermsAcknowledged) ? 'approved' : 'pending';
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO proposals (job_id, title, url, job_type, budget, client_country, keywords, cover_letter, bid, create_params, loom_url, loom_video_id, connects, score, win_score, profile_score, status, error, approved_at, approved_via)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(job.id, ready.title, ready.url, ready.jobType, ready.budget, ready.country, JSON.stringify(ready.keywords), ready.letter, ready.bid,
      JSON.stringify(createParams), ready.loomUrl, ready.loomId, null, ready.score, ready.win, ready.profile, status, ready.note,
      status === 'approved' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, status === 'approved' ? 'auto-submit' : null),
    env.DB.prepare('UPDATE jobs SET analysis = ?, status = \'proposed\', reason = ?, score = ?, win_score = ?, profile_score = ? WHERE id = ?').bind(ready.analysis, ready.scoreText, ready.score, ready.win, ready.profile, job.id),
  ]);
  if (!inserted.meta.changes) {
    const owner = await env.DB.prepare('SELECT loom_video_id FROM proposals WHERE job_id = ?').bind(job.id).first<{ loom_video_id: string | null }>();
    if (ready.loomId && owner?.loom_video_id !== ready.loomId) await deleteCopy(env, ready.loomId).catch((e) => console.error('loom: unused copy not deleted', ready.loomId, errText(e)));
  }
  await delKv(env, draftReadyKey(job.id));
  return 'queued';
}

// Flag on: score, write, and prepare Loom from the saved public snapshot. This function does not construct an Upwork client.
export async function runIndependentWriter(env: Env): Promise<WriteSummary | null> {
  const [state, s] = await Promise.all([loadState(env), loadSettings(env)]);
  if (state.paused) return null;
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'matched'
    OR (status = 'error' AND reason LIKE 'Held:%' AND NOT EXISTS (SELECT 1 FROM proposals WHERE proposals.job_id = jobs.id))`).first<{ n: number }>();
  if (!pending?.n) return null;
  const summary: WriteSummary = { queued: 0, lowScore: 0, filtered: 0, errors: 0, note: null };
  if (!env.ANTHROPIC_API_KEY) summary.note = 'Waiting for the ANTHROPIC_API_KEY secret in Cloudflare.';
  else if (!s.letter.template.trim()) summary.note = 'Waiting for the letter template in Settings → Cover letter.';
  if (summary.note) { await record(env, summary); return summary; }
  let lease = await acquireLease(env, 'write', 20 * 60_000);
  if (!lease) return null;
  try {
    const { results: jobs } = await env.DB.prepare(
      `SELECT id, title, url, job_type, budget, client_country, reason, posted_at, proposals_tier, status FROM jobs
       WHERE status = 'matched' OR (status = 'error' AND reason LIKE 'Held:%' AND NOT EXISTS (SELECT 1 FROM proposals WHERE proposals.job_id = jobs.id))
       ORDER BY CASE WHEN status = 'matched' THEN 0 ELSE 1 END, posted_at DESC, seen_at DESC LIMIT ?`,
    ).bind(s.maxNewJobsPerRun).all<JobRow>();
    const recordRow = await loadTrackRecord(env);
    await patchState(env, { writer: { startedAt: new Date().toISOString() } });
    const who: Who = { profile: profileForClaude(recordRow, s), wins: winsForClaude(recordRow) };
    const deadline = Date.now() + 12 * 60_000;
    for (const job of jobs) {
      if (Date.now() >= deadline || !(await ownsLease(env, 'write', lease)) || (await loadState(env)).paused) break;
      if (job.status === 'error') {
        if (!heldReasonCanDraft(job.reason)) continue;
        const existing = await loadSnapshot(env, job.id);
        if (!existing || snapshotHoldReason(existing.normalized, s)) continue;
      }
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
        summary[await draftFromSnapshot(env, state, s, who, job, lease)]++;
        await delKv(env, tryKey);
      } catch (e) {
        await delKv(env, tryKey);
        if (e instanceof ClaudeConfigError) { summary.note = e.message; break; }
        const msg = errText(e);
        console.error('writer: snapshot draft failed', job.id, msg);
        if (await getKv(env, draftReadyKey(job.id)) || /Controls changed while preparing/.test(msg)) {
          // A saved generation is inserted next time. A settings change is generated again. The job stays matched.
          summary.note = 'Drafting will continue on the next run.';
          break;
        }
        summary.errors++;
        await setJob(env, job.id, 'error', e instanceof ClaudeDeclined ? msg : `Could not prepare: ${msg}`);
      }
    }
  } catch (e) {
    summary.errors++; summary.note = errText(e);
    console.error('independent writer failed', summary.note);
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

export async function runWriter(env: Env): Promise<WriteSummary | null> {
  if (independentDrafts(env)) return runIndependentWriter(env);
  const [state, s] = await Promise.all([loadState(env), loadSettings(env)]);
  if (state.paused || !state.upwork.connected || !state.upwork.orgUid || !state.upwork.toolNames.find_jobs) return null;
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'matched'").first<{ n: number }>();
  if (!pending?.n) return null;

  const summary: WriteSummary = { queued: 0, lowScore: 0, filtered: 0, errors: 0, note: null };
  try { await permitJobRead(env); } catch (e) {
    if (!(e instanceof UpworkBusy)) throw e;
    summary.note = e.message;
    await record(env, summary);
    return summary;
  }
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
        if (e instanceof McpJobAccessError) {
          await setJob(env, job.id, 'error', 'Upwork API could not open this job: private/invite-only or a temporary access limit. This job will not be retried automatically.');
          summary.note = 'Upwork refused a job-detail read. Further job-detail reads wait five minutes; check the recorded trace for the cause.';
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
