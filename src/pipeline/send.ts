import { dayStartUtc } from '../api';
import { autoSendWait } from './pace';
import { emailConfigured, sendEmail } from '../email';
import { acquireLease, delKv, getKv, putKv, releaseLease, ownsLease } from '../kv';
import type { McpClient } from '../mcp';
import { findKey, upworkClient } from '../oauth';
import { loadSettings, loadState, patchState, reportEmails, type Env, type Settings, type State } from '../settings';
import { cannotApply, CLOSED_REASON, connectsOverLimit } from './filters';
import { answerQuestions, rewriteLetter, type JobForClaude } from '../claude';
import { checkAnswers, checkLetter, cleanScreeningAnswer, metaLanguageIn, resolveSendBid, type Answer } from './letter';
import { loadTrackRecord, profileForClaude } from './profile';
import { loadSnapshot } from './snapshot';
import { createPreview } from './preview';
import { alertAction, boostBid, boostSkipReason, boostReasonText, classifyFailure, connectsGate, isBoostRefusal, readConfirm, sendGate, finiteNumber } from './sendRules';
import { invitedJobIds, jobDetails } from './write';
import { clearThrottle, heldByUpwork, isThrottle, noteThrottle, pauseForWarning } from '../upworkPace';
import { clearStall, confirmProposalId, markStallOpen, markSubmitted, recoverSubmittedRows, requeueNeverConfirmed } from './submitted';

// Sender (M6): the only code that spends Connects. One approved proposal per cron run, highest score first in Review and
// newest job first in Auto (pace.ts), only when Settings → Sending is on (Siv or Celia switch it on in the dashboard;
// never in code). A confirm whose result is unclear is marked 'unknown' and never resent; the next runs look for it on Upwork.

const LEASE_MS = 10 * 60_000;
// Auto runs the sender every minute (pace.ts). After a wait or an error from Upwork, and between checks of unclear
// sends, Upwork is asked again only 5 minutes later, as in Review (30 s slack for the cron).
const RETRY_AFTER_MS = 5 * 60_000 - 30_000;
const holdRetries = (env: Env) => putKv(env, 'send:retryAt', String(Date.now() + RETRY_AFTER_MS));

interface Row {
  id: number; job_id: string; title: string; job_type: string | null; cover_letter: string; bid: number | null;
  approved_at: string | null; approved_via: string | null;
  create_params: string; score: number | null; submitted_at: string | null;
}
export interface SendSummary { sent: number; note: string | null }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const sql = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

async function setNote(env: Env, note: string | null) {
  const st = await loadState(env);
  if (st.senderNote !== note) await patchState(env, { senderNote: note });
}

async function setProposal(env: Env, id: number, fields: Record<string, string | number | null>) {
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE proposals SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map((k) => fields[k]), id).run();
}

async function countSent(env: Env, s: Settings) {
  const r = await env.DB.prepare(
    `SELECT SUM(CASE WHEN submitted_at >= ? THEN 1 ELSE 0 END) AS today,
            SUM(CASE WHEN submitted_at >= datetime('now', '-60 minutes') THEN 1 ELSE 0 END) AS hour
     FROM proposals WHERE status IN ('submitted', 'submitting', 'unknown') AND is_example = 0`,
  ).bind(dayStartUtc(s.caps.timezone)).first<{ today: number | null; hour: number | null }>();
  return { sentToday: r?.today ?? 0, sentLastHour: r?.hour ?? 0 };
}

async function readBalance(client: McpClient, state: State): Promise<number | null> {
  const tool = state.upwork.toolNames.get_freelancer_dashboard;
  if (!tool || !state.upwork.orgUid) return null;
  const r = await client.callTool(tool, { action: 'check', org_uid: state.upwork.orgUid });
  return finiteNumber(findKey(r, 'connectsBalance'));
}

// The header's Connects count, kept fresh while Sending is off too (the sender reads it again before each send).
const BALANCE_EVERY_MS = 30 * 60_000;
export async function refreshConnects(env: Env, now = Date.now()): Promise<void> {
  const state = await loadState(env);
  if (!state.upwork.connected || !state.upwork.orgUid || heldByUpwork(state)) return;
  const last = Number(await getKv(env, 'connects:checkedAt'));
  if (Number.isFinite(last) && now - last < BALANCE_EVERY_MS) return;
  await putKv(env, 'connects:checkedAt', String(now));
  const balance = await readBalance(await upworkClient(env), state);
  if (balance !== null) await patchState(env, { connectsBalance: balance });
  await checkConnectsAlert(env, balance);
}

// Low-Connects alert to the report email (Siv buys more); without email it shows on the dashboard.
export async function checkConnectsAlert(env: Env, balance: number | null) {
  const lease = await acquireLease(env, 'connects-alert', 60_000);
  if (!lease) return;
  try { await deliverConnectsAlert(env, balance); }
  finally { await releaseLease(env, 'connects-alert', lease); }
}

async function deliverConnectsAlert(env: Env, balance: number | null) {
  const [st, s] = await Promise.all([loadState(env), loadSettings(env)]);
  const action = alertAction(balance, s.connectsAlertBelow, st.connectsAlertSentAt);
  if (action === 'reset') { await patchState(env, { connectsAlertSentAt: null }); await delKv(env, 'connects:alertDelivery'); }
  if (action !== 'send') return;
  if (!emailConfigured(env) || !reportEmails(s).length) return;
  if (emailConfigured(env) && reportEmails(s).length) {
    let delivery = await getKv(env, 'connects:alertDelivery');
    if (!delivery) { delivery = crypto.randomUUID(); await putKv(env, 'connects:alertDelivery', delivery); }
    try {
      await sendEmail(env, reportEmails(s), `Upwork Connects low: ${balance} left`,
        `Rafa's Upwork account has ${balance} Connects, below the alert level of ${s.connectsAlertBelow}.\n\nSending continues while a job costs no more than the balance. Add Connects on Upwork to keep proposals going.\n\nUpwork Auto-Bidder`, undefined, `connects-low-${delivery}`);
    } catch (e) { console.error('connects alert email failed', errText(e)); return; } // retried next run
  }
  await patchState(env, { connectsAlertSentAt: new Date().toISOString() });
}

// Proposals left 'unknown' after an unclear confirm: look for them among Rafa's recent proposals on Upwork.
async function verifyUnknown(env: Env, client: McpClient, state: State) {
  const { results } = await env.DB.prepare("SELECT id, job_id, submitted_at FROM proposals WHERE status = 'unknown' ORDER BY id LIMIT 5")
    .all<{ id: number; job_id: string; submitted_at: string | null }>();
  const tool = state.upwork.toolNames.list_freelancer_proposals;
  if (!results.length || !tool || !state.upwork.orgUid) return;
  const last = Number(await getKv(env, 'unknown:checkedAt'));
  if (Number.isFinite(last) && Date.now() - last < RETRY_AFTER_MS) return;
  await putKv(env, 'unknown:checkedAt', String(Date.now()));
  const nodes: unknown[] = [];
  for (const status of ['Pending', 'Accepted', 'Offered', 'Hired', 'Declined', 'Withdrawn', 'Archived']) {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await client.callTool(tool, { action: 'list', org_uid: state.upwork.orgUid, params: { status, limit: 10, sort_field: 'CREATEDDATETIME', sort_order: 'DESC', ...(cursor ? { cursor } : {}) } });
      const edges = findKey(r, 'edges') ?? findKey(r, 'proposals');
      if (!Array.isArray(edges)) throw new Error('Unclear reconciliation response; preserving unknown submissions.');
      nodes.push(...edges.map(e => findKey(e, 'node') ?? e));
      const info = findKey(r, 'pageInfo') as { hasNextPage?: boolean; endCursor?: string } | undefined;
      if (!info?.hasNextPage || !info.endCursor || info.endCursor === cursor) break;
      cursor = info.endCursor;
    }
  }
  for (const p of results) {
    const hit = nodes.find(n => [findKey(n, 'jobId'), findKey(n, 'job_id'), findKey(findKey(n, 'jobPosting'), 'id')]
      .some(id => typeof id === 'string' && id.replace(/^~02/, '') === p.job_id));
    if (!hit) continue; // Absence on a partial or changing list is never proof that nothing was submitted.
    const id = findKey(hit, 'proposalId') ?? findKey(hit, 'id');
    await setProposal(env, p.id, { status: 'submitted', upwork_proposal_id: id === undefined ? null : String(id), error: 'Confirmed on Upwork after an unclear answer' });
    if (p.submitted_at) {
      const current = await loadState(env);
      const at = `${p.submitted_at.replace(' ', 'T')}Z`;
      if (!current.lastSendAt || Date.parse(at) > Date.parse(current.lastSendAt)) await patchState(env, { lastSendAt: at });
    }
  }
}

// null means the live preview omitted the list. An explicit empty list is a real "no questions" answer.
// A question hold drops the previous approval. Auto must not pick the same row up again.
async function holdForReview(env: Env, id: number, message: string, summary: SendSummary): Promise<SendSummary> {
  await setProposal(env, id, { status: 'pending', submitted_at: null, approved_at: null, approved_via: null, error: message });
  summary.note = message;
  return summary;
}

function questionsDiffer(questions: string[] | null, answers: Answer[]): boolean {
  if (!questions?.length) return false;
  return !!checkAnswers(questions, answers) || questions.some((q, i) => answers[i]?.question !== q);
}

// The preview the sender already requested is where the question list arrives. A missing or empty list means there
// are no questions. A real list is answered here and attached by rebuilding that same preview, not by a new read.
async function answerLiveQuestions(env: Env, row: Row, questions: string[], s: Settings): Promise<Answer[] | null> {
  const snap = await loadSnapshot(env, row.job_id);
  const job: JobForClaude = {
    title: row.title, jobType: row.job_type, budget: null, country: null,
    description: snap?.normalized.description ?? '', clientFeedbackNames: [],
  };
  const profile = profileForClaude(await loadTrackRecord(env), s);
  let answers = await answerQuestions(env, profile, job, questions);
  if (answers.length === questions.length) answers = questions.map((question, i) => ({ question, answer: answers[i]?.answer ?? '' }));
  let bad = checkAnswers(questions, answers);
  if (bad) {
    answers = await answerQuestions(env, profile, job, questions, bad);
    if (answers.length === questions.length) answers = questions.map((question, i) => ({ question, answer: answers[i]?.answer ?? '' }));
    bad = checkAnswers(questions, answers);
  }
  return bad ? null : answers;
}

function storedParams(row: Row): { extra: Record<string, string>; answers: Answer[] } {
  try {
    const p = JSON.parse(row.create_params || '{}') as Record<string, unknown>;
    const extra: Record<string, string> = {};
    for (const k of ['payment_mode', 'estimated_duration', 'application_method']) if (typeof p[k] === 'string') extra[k] = p[k] as string;
    return { extra, answers: Array.isArray(p.answers) ? (p.answers as Answer[]) : [] };
  } catch { return { extra: {}, answers: [] }; }
}

async function countError(env: Env, s: Settings, reason: string) {
  const st = await loadState(env);
  const n = st.consecutiveErrors + 1;
  await patchState(env, n >= s.caps.stopAfterErrors
    ? { consecutiveErrors: n, paused: true, pausedReason: `${n} errors in a row while sending. Last: ${reason}` }
    : { consecutiveErrors: n });
}

export async function runSender(env: Env): Promise<SendSummary | null> {
  const lease = await acquireLease(env, 'send', LEASE_MS);
  if (!lease) return null;
  try { return await runSenderLocked(env, lease); }
  finally { await releaseLease(env, 'send', lease); }
}

async function runSenderLocked(env: Env, lease: string): Promise<SendSummary | null> {
  // A returned Upwork proposal id means the proposal is submitted, even if the previous run died before the status update.
  await recoverSubmittedRows(env);
  await requeueNeverConfirmed(env);
  // A run that died after confirm may have been sent, so never resend. A claim with no preview never reached confirm.
  await env.DB.prepare(
    `UPDATE proposals SET status = 'unknown', error = 'Interrupted while sending; checking on Upwork, not resending'
     WHERE status = 'submitting' AND preview_id IS NOT NULL
       AND (submitted_at IS NULL OR submitted_at < datetime('now', '-15 minutes'))
       AND (upwork_proposal_id IS NULL OR length(trim(upwork_proposal_id)) = 0)`,
  ).run();
  const [state, s] = await Promise.all([loadState(env), loadSettings(env)]);
  const latest = await env.DB.prepare("SELECT MAX(submitted_at) AS at FROM proposals WHERE status = 'submitted' AND is_example = 0").first<{ at: string | null }>();
  if (latest?.at) {
    const at = `${latest.at.replace(' ', 'T')}Z`;
    if (!state.lastSendAt || Date.parse(at) > Date.parse(state.lastSendAt)) state.lastSendAt = at;
  }
  const fixedOk = s.fixedPriceTermsAcknowledged ? 1 : 0;
  const manualRow = await env.DB.prepare(
    `SELECT p.id, p.job_id, p.title, p.job_type, p.cover_letter, p.bid, p.create_params, p.score, p.submitted_at, p.approved_at, p.approved_via
     FROM proposals p WHERE p.status = 'approved' AND p.approved_via = 'dashboard' AND p.is_example = 0
     AND (p.job_type IS NOT 'fixed' OR ? = 1) ORDER BY p.approved_at ASC LIMIT 1`,
  ).bind(fixedOk).first<Row>();
  const counts = await countSent(env, s);
  // A clicked Approve skips the random 3–9 minute Auto spacing and the configured gap. Caps and active hours still apply.
  const gate = manualRow ? sendGate(state, s, counts, new Date(), true) : sendGate(state, s, counts) ?? await autoSendWait(env, state);
  const hasUnknown = await env.DB.prepare("SELECT 1 FROM proposals WHERE status = 'unknown' LIMIT 1").first();
  if (gate && !(hasUnknown && s.sendingEnabled && !state.paused && state.upwork.connected)) { await setNote(env, gate); return null; }

  // Review: the closest match first. Auto: the newest job first, since speed after posting matters most (Siv, Oct 27).
  const order = state.mode === 'auto' ? 'j.posted_at DESC, p.created_at DESC' : 'p.score DESC, p.created_at ASC';
  const row = manualRow ?? (gate ? null : await env.DB.prepare(
    `SELECT p.id, p.job_id, p.title, p.job_type, p.cover_letter, p.bid, p.create_params, p.score, p.submitted_at, p.approved_at, p.approved_via
     FROM proposals p LEFT JOIN jobs j ON j.id = p.job_id
     WHERE p.status = 'approved' AND p.is_example = 0 AND (p.job_type IS NOT 'fixed' OR ? = 1) ORDER BY ${order} LIMIT 1`,
  ).bind(fixedOk).first<Row>());
  if (!gate && !row) {
    const fixedWaiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'approved' AND job_type = 'fixed'").first<{ n: number }>();
    await setNote(env, fixedWaiting?.n ? `${fixedWaiting.n} fixed-price proposal(s) wait for the Upwork terms acknowledgement (Settings → Sending).` : 'Nothing approved to send.');
    if (!hasUnknown) return null;
  }
  const held = Number(await getKv(env, 'send:retryAt')) > Date.now();
  if (held && !hasUnknown) return null; // the note from the last try stays
  const summary: SendSummary = { sent: 0, note: gate ?? (row ? null : 'Nothing approved to send.') };
  let confirmAttempted = false;
  let stallId: number | null = null;
  let previewStored = false;
  try {
    if (row) {
      const meta = metaLanguageIn(row.cover_letter);
      if (meta) {
        let cleaned: string | null = null;
        try { cleaned = await rewriteLetter(env, row.cover_letter, meta); } catch { cleaned = null; }
        const loom = cleaned?.replace(/https:\/\/(?:www\.)?loom\.com\/share\/\S+/g, '') ?? '';
        if (!cleaned || metaLanguageIn(cleaned) || checkLetter(loom, null)) {
          return await holdForReview(env, row.id, `Not sent: the letter contains ${meta}.`, summary);
        }
        await setProposal(env, row.id, { cover_letter: cleaned, error: null });
        row.cover_letter = cleaned;
      }
    }
    const client = await upworkClient(env);
    if (hasUnknown) await verifyUnknown(env, client, state);
    if (!row || gate) return summary;
    if (held) { summary.note = state.senderNote; return summary; }
    // An unclear attempt remains reserved until it is reconciled or explicitly resolved.
    const unclear = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'unknown'").first<{ n: number }>();
    if (unclear?.n) { summary.note = `Checking ${unclear.n} unclear send(s) on Upwork before sending more.`; return summary; }
    await markStallOpen(env, row.id);
    stallId = row.id;

    const balance = await readBalance(client, state);
    if (balance !== null) await patchState(env, { connectsBalance: balance });
    await checkConnectsAlert(env, balance);

    let d: Awaited<ReturnType<typeof jobDetails>>;
    try { d = await jobDetails(client, state, row.job_id); } catch (e) {
      if (classifyFailure(e) !== 'refused') throw e;
      await setProposal(env, row.id, { status: 'failed', error: `The job is no longer available on Upwork: ${errText(e)}` }); summary.note = 'A job was no longer available.'; return summary;
    }
    const invited = await invitedJobIds(client, state);
    const drop = d.applied ? 'Already applied on Upwork (no Connects spent)'
      : invited.has(row.job_id) ? 'Invited: answer the invitation on Upwork'
      : cannotApply(d.canApply, d.connectsCost, balance ?? d.connectsBalance) === 'closed' ? CLOSED_REASON
      : connectsOverLimit(d.connectsCost, s);
    if (drop) { await setProposal(env, row.id, { status: 'failed', error: drop }); summary.note = drop; return summary; }
    // The job details carry the balance too; use it when the account read failed.
    const wait = connectsGate(balance ?? d.connectsBalance, d.connectsCost, s);
    if (wait) { summary.note = wait; await holdRetries(env); return summary; }
    const storedBasis = (() => { try { const p = JSON.parse(row.create_params || '{}') as { bid_basis?: unknown }; return typeof p.bid_basis === 'string' ? p.bid_basis : null; } catch { return null; } })();
    const decision = resolveSendBid({ jobType: row.job_type, bid: row.bid, bidBasis: storedBasis, liveType: d.jobType, liveBudget: d.budget, settings: s });
    if (decision.hold || decision.bid === null) return await holdForReview(env, row.id, decision.hold ?? 'Not sent: no bid amount is available.', summary);
    if (decision.bid !== row.bid || decision.jobType !== row.job_type) {
      await setProposal(env, row.id, { bid: decision.bid, job_type: decision.jobType });
      if (decision.basis === 'bidder-hourly-usd' || !d.budget) await env.DB.prepare('UPDATE jobs SET job_type = ? WHERE id = ?').bind(decision.jobType, row.job_id).run();
      else await env.DB.prepare('UPDATE jobs SET job_type = ?, budget = ? WHERE id = ?').bind(decision.jobType, d.budget, row.job_id).run();
      row.bid = decision.bid;
      row.job_type = decision.jobType;
    }

    const { extra } = storedParams(row);
    let { answers } = storedParams(row);
    const cleanedAnswers = answers.map((answer) => ({ ...answer, answer: cleanScreeningAnswer(answer.answer) }));
    if (cleanedAnswers.some((answer, i) => answer.answer !== answers[i]?.answer)) {
      answers = cleanedAnswers;
      const params = JSON.parse(row.create_params || '{}') as Record<string, unknown>;
      params.answers = answers;
      row.create_params = JSON.stringify(params);
      await setProposal(env, row.id, { create_params: row.create_params });
    }
    const fixed = row.job_type === 'fixed';
    const boostKey = `boostRefused:${row.id}`;
    const boostRefusals = Number(await getKv(env, boostKey) ?? 0);
    let previewId: string;
    let finalCost: number | null = null;
    let boost: number | null = null;
    try {
      let p = await createPreview(client, state, { jobId: row.job_id, letter: row.cover_letter, bid: row.bid, fixed, extra, answers });
      if (cannotApply(p.canApply, p.connectsCost, balance) === 'closed') { await setProposal(env, row.id, { status: 'failed', submitted_at: null, error: CLOSED_REASON }); return summary; }
      if (questionsDiffer(p.questions, answers)) {
        const answered = await answerLiveQuestions(env, row, p.questions ?? [], s);
        if (answered) {
          answers = answered.map((answer) => ({ ...answer, answer: cleanScreeningAnswer(answer.answer) }));
          const params = JSON.parse(row.create_params || '{}') as Record<string, unknown>;
          params.answers = answers;
          params.questions_state = 'live';
          row.create_params = JSON.stringify(params);
          await setProposal(env, row.id, { create_params: row.create_params });
          p = await createPreview(client, state, { jobId: row.job_id, letter: row.cover_letter, bid: row.bid, fixed, extra: p.extra, answers });
        }
      }
      if (p.connectsCost !== null && balance !== null && p.connectsCost > balance) {
        await setProposal(env, row.id, { status: 'approved', submitted_at: null }); summary.note = `Waiting for Connects: balance ${balance}, this job costs ${p.connectsCost}.`;
        await holdRetries(env); return summary;
      }
      // Boost when eligible; a boost-only failure must not prevent a normal application.
      const left = balance !== null && p.connectsCost !== null ? balance - p.connectsCost : null;
      boost = boostRefusals < 2 ? boostBid(row.score, p.boost, s, left) : null;
      let boostReason = boostRefusals >= 2 ? 'two_boost_bids_refused' : boostSkipReason(row.score, p.boost, s, left);
      const recordBoostDecision = () => putKv(env, `boost:decision:${row.id}`, JSON.stringify({
        at: new Date().toISOString(), proposalId: row.id, mode: state.mode,
        bid: boost, reason: boostReason, note: boostReasonText(boostReason),
        score: row.score, minScore: s.caps.boostMinScore, maxBid: s.caps.boostMaxConnects,
        remainingConnects: left, upwork: p.boost, metadata: p.boostDiagnostics ?? null,
      }));
      await recordBoostDecision();
      if (boost) {
        try {
          p = await createPreview(client, state, { jobId: row.job_id, letter: row.cover_letter, bid: row.bid, fixed, extra: p.extra, answers, boostConnects: boost });
        } catch (e) {
          // Only an explicit boost refusal can fall back. Warnings, throttles and uncertain
          // errors retain the existing safety handling. Rebuild a fresh normal preview for fallback.
          if (classifyFailure(e) !== 'refused' || !isBoostRefusal(errText(e))) throw e;
          boost = null;
          boostReason = 'upwork_boost_preview_refused';
          await recordBoostDecision();
          p = await createPreview(client, state, { jobId: row.job_id, letter: row.cover_letter, bid: row.bid, fixed, extra: p.extra, answers });
        }
      }
      previewId = p.previewId;
      finalCost = p.connectsCost;
      const violation = cannotApply(p.canApply, p.connectsCost, balance) ? 'The final preview is not eligible.'
        : connectsOverLimit(p.connectsCost, s)
        ?? connectsGate(balance, p.connectsCost === null ? null : p.connectsCost + (boost ?? 0), s)
        ?? checkLetter(row.cover_letter.replace(/https:\/\/(?:www\.)?loom\.com\/share\/\S+/g, ''), null);
      if (violation) {
        await setProposal(env, row.id, { status: 'pending', submitted_at: null, error: violation });
        summary.note = 'A proposal needs review: ' + violation; return summary;
      }
    } catch (e) {
      // Nothing was sent at the preview step, so the proposal can go back to approved.
      const kind = classifyFailure(e);
      if (kind === 'refused') { await setProposal(env, row.id, { status: 'failed', submitted_at: null, error: `Upwork refused the proposal: ${errText(e)}` }); return summary; }
      await setProposal(env, row.id, { status: 'approved', submitted_at: null });
      if (kind === 'throttle') { await noteThrottle(env, 'sending', errText(e)); summary.note = 'Upwork asked to slow down; sending again next round.'; return summary; }
      await holdRetries(env);
      if (kind === 'warning') await pauseForWarning(env, 'sending', errText(e));
      else await countError(env, s, errText(e));
      summary.note = `Preview failed: ${errText(e)}`; return summary;
    }

    // Claim only once the preview exists. A cancelled run before this point leaves the row approved.
    const claimed = await env.DB.prepare("UPDATE proposals SET status = 'submitting', submitted_at = ? WHERE id = ? AND status = 'approved' AND cover_letter = ? AND bid IS ? AND create_params = ? AND approved_at IS ?").bind(sql(new Date()), row.id, row.cover_letter, row.bid, row.create_params, row.approved_at).run();
    if (!claimed.meta.changes) return summary;

    // A rejected boost sent nothing: retry the bid; after two refusals send normally and record why.
    const boostRefused = async (message: string) => {
      await setProposal(env, row.id, { status: 'approved', submitted_at: null, error: null });
      await putKv(env, boostKey, String(boostRefusals + 1));
      summary.note = `The boost bid no longer took a top slot (${message.slice(0, 120)}); trying again.`;
      return summary;
    };

    const [current, settings, proposal] = await Promise.all([
      loadState(env), loadSettings(env),
      env.DB.prepare('SELECT status, cover_letter, bid, create_params, approved_at FROM proposals WHERE id = ?').bind(row.id).first<Row & { status: string }>(),
    ]);
    const counts = await countSent(env, settings);
    // This attempt is claimed but has not been transmitted; exclude its own reservation.
    counts.sentToday = Math.max(0, counts.sentToday - 1);
    counts.sentLastHour = Math.max(0, counts.sentLastHour - 1);
    const manual = row.approved_via === 'dashboard';
    const blocked = (manual ? sendGate(current, settings, counts, new Date(), true) : sendGate(current, settings, counts) ?? await autoSendWait(env, current))
      ?? (current.controlsVersion !== state.controlsVersion ? 'Controls changed while preparing this send.' : null)
      ?? (JSON.stringify(settings) !== JSON.stringify(s) ? 'Settings changed while preparing this send.' : null)
      ?? (current.mode === 'review' && row.approved_via !== 'dashboard' ? 'Manual approval is required in Review mode.' : null);
    if (blocked || !(await ownsLease(env, 'send', lease)) || !proposal || proposal.status !== 'submitting'
      || proposal.cover_letter !== row.cover_letter || proposal.bid !== row.bid || proposal.create_params !== row.create_params || proposal.approved_at !== row.approved_at) {
      await env.DB.prepare("UPDATE proposals SET status = 'pending', submitted_at = NULL, approved_at = NULL, approved_via = NULL, error = ? WHERE id = ? AND status = 'submitting'")
        .bind(blocked ?? 'Approval or sender ownership changed; review again.', row.id).run();
      summary.note = blocked ?? 'Proposal needs review again.'; return summary;
    }
    const attemptAt = sql(new Date());
    previewStored = true;
    await clearStall(env, row.id);
    await env.DB.prepare("UPDATE proposals SET connects = ?, boost_connects = ?, preview_id = ? WHERE id = ? AND status = 'submitting'")
      .bind(finalCost, boost, previewId, row.id).run();
    const attemptKey = `send:attempt:${crypto.randomUUID()}`;
    await putKv(env, attemptKey, JSON.stringify({ at: attemptAt, proposalId: row.id, jobId: row.job_id, previewId,
      letter: row.cover_letter, bid: row.bid, answers, cost: finalCost, boost, approvedAt: row.approved_at, approvedVia: row.approved_via }));
    confirmAttempted = true;
    let r: unknown;
    try {
      const tool = state.upwork.toolNames.confirm_preview;
      if (!tool) throw Object.assign(new Error('Upwork confirm tool is missing. Press Check now under Settings → Upwork.'), { notSent: true });
      client.confirmGuard = async () => {
        const [latest, config] = await Promise.all([loadState(env), loadSettings(env)]);
        if (latest.paused || !config.sendingEnabled || latest.controlsVersion !== current.controlsVersion
          || JSON.stringify(config) !== JSON.stringify(settings) || !(await ownsLease(env, 'send', lease))) {
          throw Object.assign(new Error('Sending controls changed before dispatch; review again.'), { notSent: true });
        }
      };
      r = await client.callTool(tool, { action: 'confirm', org_uid: state.upwork.orgUid, params: { type: 'proposal', preview_id: previewId } });
    } catch (e) {
      const notSent = (e as { notSent?: boolean }).notSent === true;
      if (notSent) {
        await setProposal(env, row.id, { status: 'pending', submitted_at: null, approved_at: null, approved_via: null, error: errText(e) });
        summary.note = errText(e); return summary;
      }
      const kind = classifyFailure(e);
      if (kind === 'needs_confirmation') {
        // Upwork wants a person to click: everything goes back to Review (BUILD_PLAN §2); this proposal waits approved.
        await setProposal(env, row.id, { status: 'approved', submitted_at: null, error: null });
        await patchState(env, { mode: 'review', paused: true, pausedReason: 'Upwork asked for a person to confirm proposals. Nothing is sent until you resume.', switchedToReviewReason: `Upwork asked for a person to confirm: ${errText(e)}` });
        summary.note = 'Switched to Review: Upwork asked for a person to confirm.'; return summary;
      }
      if (kind === 'refused' && boost && isBoostRefusal(errText(e))) return await boostRefused(errText(e));
      if (kind === 'refused') {
        await setProposal(env, row.id, { status: 'failed', submitted_at: null, error: `Upwork refused the proposal: ${errText(e)}` });
        await countError(env, s, errText(e));
        summary.note = `Upwork refused a proposal: ${errText(e)}`;
        return summary;
      }
      if (kind === 'throttle') {
        await setProposal(env, row.id, { status: 'unknown', submitted_at: attemptAt, boost_connects: boost, error: 'Rate limit during confirmation; checking Upwork before any retry.' });
        await noteThrottle(env, 'sending', errText(e));
        summary.note = 'Upwork asked to slow down; sending again next round.'; return summary;
      }
      if (kind === 'warning') {
        await setProposal(env, row.id, { status: 'unknown', submitted_at: attemptAt, boost_connects: boost, error: 'Account warning during confirmation; checking Upwork before any retry.' });
        await pauseForWarning(env, 'sending', errText(e));
        summary.note = 'Paused: Upwork account warning.'; return summary;
      }
      // Timeout, dropped connection, 5xx: it may have gone through. Never resend; verify on the next runs.
      await setProposal(env, row.id, { status: 'unknown', submitted_at: attemptAt, boost_connects: boost, error: `Unclear answer from Upwork (${errText(e)}); checking, not resending` });
      await countError(env, s, errText(e));
      summary.note = 'Unclear answer from Upwork; checking before anything else is sent.';
      return summary;
    }

    const proposalId = confirmProposalId(r);
    if (proposalId) {
      await markSubmitted(env, row.id, attemptAt, proposalId, finalCost, boost);
    }
    const out = readConfirm(r);
    if (proposalId) {
      if (boostRefusals) await delKv(env, boostKey);
      await clearThrottle(env);
      summary.sent = 1; summary.note = `last proposal sent at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: s.caps.timezone })}${boost ? ` (boosted, bid ${boost} Connects)` : ''}`;
      const after = await readBalance(client, state).catch(() => null) ?? (balance !== null && finalCost !== null ? balance - finalCost - (boost ?? 0) : null);
      await patchState(env, { lastSendAt: new Date().toISOString(), consecutiveErrors: 0, ...(after !== null ? { connectsBalance: after } : {}) });
      await checkConnectsAlert(env, after);
      await env.DB.prepare("INSERT INTO runs (finished_at, submitted, note) VALUES (datetime('now'), 1, ?)").bind(summary.note).run();
      return summary;
    }
    if (!out.ok) {
      if (out.uncertain) {
        await setProposal(env, row.id, { status: 'unknown', submitted_at: attemptAt, boost_connects: boost, error: 'Unrecognized confirmation result; checking, never resending.' });
        summary.note = 'Checking an unclear confirmation on Upwork.'; return summary;
      }
      // Upwork answered and said no: nothing was sent.
      const kind = classifyFailure(new Error(out.message));
      if (kind === 'needs_confirmation') {
        await setProposal(env, row.id, { status: 'approved', submitted_at: null, error: null });
        await patchState(env, { mode: 'review', paused: true, pausedReason: 'Upwork asked for a person to confirm proposals. Nothing is sent until you resume.', switchedToReviewReason: `Upwork asked for a person to confirm: ${out.message}` });
        summary.note = 'Switched to Review: Upwork asked for a person to confirm.'; return summary;
      }
      if (kind === 'throttle') {
        await setProposal(env, row.id, { status: 'approved', submitted_at: null, error: null });
        await noteThrottle(env, 'sending', out.message);
        summary.note = 'Upwork asked to slow down; sending again next round.'; return summary;
      }
      if (kind !== 'warning' && boost && isBoostRefusal(out.message)) return await boostRefused(out.message);
      await setProposal(env, row.id, { status: 'failed', submitted_at: null, error: `Upwork refused the proposal: ${out.message}` });
      summary.note = `Upwork refused a proposal: ${out.message}`;
      if (kind === 'warning') await pauseForWarning(env, 'sending', out.message);
      else await countError(env, s, out.message);
      return summary;
    }
    await setProposal(env, row.id, { status: 'submitted', submitted_at: attemptAt, upwork_proposal_id: out.proposalId, connects: finalCost, boost_connects: boost, error: null });
    if (boostRefusals) await delKv(env, boostKey);
    await clearThrottle(env);
    summary.sent = 1; summary.note = `last proposal sent at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: s.caps.timezone })}${boost ? ` (boosted, bid ${boost} Connects)` : ''}`;
    const after = await readBalance(client, state).catch(() => null) ?? (balance !== null && finalCost !== null ? balance - finalCost - (boost ?? 0) : null);
    await patchState(env, { lastSendAt: new Date().toISOString(), consecutiveErrors: 0, ...(after !== null ? { connectsBalance: after } : {}) });
    await checkConnectsAlert(env, after);
    await env.DB.prepare("INSERT INTO runs (finished_at, submitted, note) VALUES (datetime('now'), 1, ?)").bind(summary.note).run();
    return summary;
  } catch (e) {
    summary.note = `Sender: ${errText(e)}`;
    console.error('sender failed', summary.note);
    if (classifyFailure(e) === 'warning') await pauseForWarning(env, 'sending', errText(e));
    // Before the confirm it is safe to retry later; after it, never: the proposal may already be on Upwork.
    // Upwork's per-minute limit (e.g. on the job check) is retried next run; anything else waits 5 minutes.
    if (row && !confirmAttempted) {
      if (isThrottle(e)) await noteThrottle(env, 'sending', errText(e)).catch(() => false);
      else await holdRetries(env).catch(() => undefined);
    }
    if (row) {
      await env.DB.prepare(confirmAttempted
        ? "UPDATE proposals SET status = 'unknown', error = 'Error after sending; checking on Upwork, not resending' WHERE id = ? AND status = 'submitting'"
        : "UPDATE proposals SET status = 'approved', submitted_at = NULL WHERE id = ? AND status = 'submitting'").bind(row.id).run();
    }
    return summary;
  } finally {
    if (stallId !== null && !previewStored) await clearStall(env, stallId);
    await setNote(env, summary.note);
  }
}
