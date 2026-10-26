import { dayStartUtc } from '../api';
import { emailConfigured, sendEmail } from '../email';
import { acquireLease, getKv, putKv, releaseLease } from '../kv';
import type { McpClient } from '../mcp';
import { findKey, upworkClient } from '../oauth';
import { loadSettings, loadState, patchState, reportEmails, type Env, type Settings, type State } from '../settings';
import { cannotApply, CLOSED_REASON, connectsOverLimit } from './filters';
import type { Answer } from './letter';
import { createPreview } from './preview';
import { alertAction, classifyFailure, connectsGate, readConfirm, sendGate } from './sendRules';
import { invitedJobIds, jobDetails } from './write';

// Sender (M6): the only code that spends Connects. One approved proposal per cron run, highest score first, only when
// Settings → Sending is on (Siv or Celia switch it on in the dashboard; never in code). A confirm whose result is
// unclear is marked 'unknown' and never resent; the next runs look for it on Upwork.

const LEASE_MS = 10 * 60_000;
const UNKNOWN_GIVE_UP_MS = 24 * 3600_000;

interface Row {
  id: number; job_id: string; title: string; job_type: string | null; cover_letter: string; bid: number | null;
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
     FROM proposals WHERE status = 'submitted'`,
  ).bind(dayStartUtc(s.caps.timezone)).first<{ today: number | null; hour: number | null }>();
  return { sentToday: r?.today ?? 0, sentLastHour: r?.hour ?? 0 };
}

async function readBalance(client: McpClient, state: State): Promise<number | null> {
  const tool = state.upwork.toolNames.get_freelancer_dashboard;
  if (!tool || !state.upwork.orgUid) return null;
  const r = await client.callTool(tool, { action: 'check', org_uid: state.upwork.orgUid });
  const n = Number(findKey(r, 'connectsBalance'));
  return Number.isFinite(n) ? n : null;
}

// The header's Connects count, kept fresh while Sending is off too (the sender reads it again before each send).
const BALANCE_EVERY_MS = 30 * 60_000;
export async function refreshConnects(env: Env, now = Date.now()): Promise<void> {
  const state = await loadState(env);
  if (!state.upwork.connected || !state.upwork.orgUid) return;
  const last = Number(await getKv(env, 'connects:checkedAt'));
  if (Number.isFinite(last) && now - last < BALANCE_EVERY_MS) return;
  await putKv(env, 'connects:checkedAt', String(now));
  const balance = await readBalance(await upworkClient(env), state);
  if (balance !== null) await patchState(env, { connectsBalance: balance });
  await checkConnectsAlert(env, balance);
}

// Low-Connects alert to the report email (Siv buys more); without email it shows on the dashboard.
export async function checkConnectsAlert(env: Env, balance: number | null) {
  const [st, s] = await Promise.all([loadState(env), loadSettings(env)]);
  const action = alertAction(balance, s.connectsAlertBelow, st.connectsAlertSentAt);
  if (action === 'reset') await patchState(env, { connectsAlertSentAt: null });
  if (action !== 'send') return;
  if (emailConfigured(env) && reportEmails(s).length) {
    try {
      await sendEmail(env, reportEmails(s), `Upwork Connects low: ${balance} left`,
        `Rafa's Upwork account has ${balance} Connects, below the alert level of ${s.connectsAlertBelow}.\n\nSending continues while a job costs no more than the balance. Add Connects on Upwork to keep proposals going.\n\nUpwork Auto-Bidder`);
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
  const nodes: unknown[] = [];
  for (const status of ['Pending', 'Accepted']) {
    const r = await client.callTool(tool, { action: 'list', org_uid: state.upwork.orgUid, params: { status, limit: 10, sort_field: 'CREATEDDATETIME', sort_order: 'DESC' } }).catch(() => null);
    const edges = findKey(r, 'edges') ?? findKey(r, 'proposals');
    if (Array.isArray(edges)) nodes.push(...edges.map((e) => findKey(e, 'node') ?? e));
  }
  for (const p of results) {
    const hit = nodes.find((n) => JSON.stringify(n).includes(`"${p.job_id}"`) || JSON.stringify(n).includes(`~02${p.job_id}`));
    if (hit) {
      const id = findKey(hit, 'id');
      await setProposal(env, p.id, { status: 'submitted', upwork_proposal_id: id === undefined ? null : String(id), error: 'Confirmed on Upwork after an unclear answer' });
    } else if (p.submitted_at && Date.now() - Date.parse(`${p.submitted_at.replace(' ', 'T')}Z`) > UNKNOWN_GIVE_UP_MS) {
      await setProposal(env, p.id, { status: 'failed', error: 'Not found on Upwork 24 h after an unclear answer; check Upwork before approving again' });
    }
  }
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
  // A run that died mid-send (Workers limit, deploy) leaves 'submitting' behind: it may have been sent, so never resend.
  await env.DB.prepare(
    `UPDATE proposals SET status = 'unknown', error = 'Interrupted while sending; checking on Upwork, not resending'
     WHERE status = 'submitting' AND (submitted_at IS NULL OR submitted_at < datetime('now', '-15 minutes'))`,
  ).run();
  const [state, s] = await Promise.all([loadState(env), loadSettings(env)]);
  const gate = sendGate(state, s, await countSent(env, s));
  const hasUnknown = await env.DB.prepare("SELECT 1 FROM proposals WHERE status = 'unknown' LIMIT 1").first();
  if (gate && !(hasUnknown && s.sendingEnabled && !state.paused && state.upwork.connected)) { await setNote(env, gate); return null; }

  const fixedOk = s.fixedPriceTermsAcknowledged ? 1 : 0;
  const row = gate ? null : await env.DB.prepare(
    `SELECT id, job_id, title, job_type, cover_letter, bid, create_params, score, submitted_at FROM proposals
     WHERE status = 'approved' AND (job_type IS NOT 'fixed' OR ? = 1) ORDER BY score DESC, created_at ASC LIMIT 1`,
  ).bind(fixedOk).first<Row>();
  if (!gate && !row) {
    const fixedWaiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'approved' AND job_type = 'fixed'").first<{ n: number }>();
    await setNote(env, fixedWaiting?.n ? `${fixedWaiting.n} fixed-price proposal(s) wait for the Upwork terms acknowledgement (Settings → Sending).` : 'Nothing approved to send.');
    if (!hasUnknown) return null;
  }
  if (!(await acquireLease(env, 'send', LEASE_MS))) return null;

  const summary: SendSummary = { sent: 0, note: gate ?? (row ? null : 'Nothing approved to send.') };
  let confirmAttempted = false;
  try {
    const client = await upworkClient(env);
    if (hasUnknown) await verifyUnknown(env, client, state);
    if (!row || gate) return summary;
    // While a send from the last hour has an unclear result, send nothing new: a flaky Upwork must not cause a chain.
    const unclear = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'unknown' AND submitted_at >= datetime('now', '-60 minutes')").first<{ n: number }>();
    if (unclear?.n) { summary.note = `Checking ${unclear.n} unclear send(s) on Upwork before sending more.`; return summary; }

    const balance = await readBalance(client, state).catch(() => null);
    if (balance !== null) await patchState(env, { connectsBalance: balance });
    await checkConnectsAlert(env, balance);

    let d: Awaited<ReturnType<typeof jobDetails>>;
    try { d = await jobDetails(client, state, row.job_id); } catch (e) {
      if (classifyFailure(e) !== 'refused') throw e;
      await setProposal(env, row.id, { status: 'failed', error: `The job is no longer available on Upwork: ${errText(e)}` }); summary.note = 'A job was no longer available.'; return summary;
    }
    const invited = await invitedJobIds(client, state).catch(() => new Set<string>());
    const drop = d.applied ? 'Already applied on Upwork (no Connects spent)'
      : invited.has(row.job_id) ? 'Invited: answer the invitation on Upwork'
      : cannotApply(d.canApply, d.connectsCost, balance ?? d.connectsBalance) === 'closed' ? CLOSED_REASON
      : connectsOverLimit(d.connectsCost, s);
    if (drop) { await setProposal(env, row.id, { status: 'failed', error: drop }); summary.note = drop; return summary; }
    // The job details carry the balance too; use it when the account read failed.
    const wait = connectsGate(balance ?? d.connectsBalance, d.connectsCost, s);
    if (wait) { summary.note = wait; return summary; }
    if (row.bid === null) { await setProposal(env, row.id, { status: 'failed', error: 'No bid amount stored' }); return summary; }

    // Claim it, so a parallel run or an Undo can't race this send.
    const claimed = await env.DB.prepare("UPDATE proposals SET status = 'submitting', submitted_at = ? WHERE id = ? AND status = 'approved'").bind(sql(new Date()), row.id).run();
    if (!claimed.meta.changes) return summary;

    const { extra, answers } = storedParams(row);
    const fixed = row.job_type === 'fixed';
    let previewId: string;
    try {
      const p = await createPreview(client, state, { jobId: row.job_id, letter: row.cover_letter, bid: row.bid, fixed, extra, answers });
      if (cannotApply(p.canApply, p.connectsCost, balance) === 'closed') { await setProposal(env, row.id, { status: 'failed', submitted_at: null, error: CLOSED_REASON }); return summary; }
      if (p.questions.length && p.questions.length !== answers.length) {
        await setProposal(env, row.id, { status: 'pending', submitted_at: null, error: `Upwork now shows ${p.questions.length} screening question(s); review the answers and approve again` });
        summary.note = 'A proposal went back to review: new screening questions.'; return summary;
      }
      if (p.connectsCost !== null && balance !== null && p.connectsCost > balance) {
        await setProposal(env, row.id, { status: 'approved', submitted_at: null }); summary.note = `Waiting for Connects: balance ${balance}, this job costs ${p.connectsCost}.`; return summary;
      }
      previewId = p.previewId;
    } catch (e) {
      // Nothing was sent at the preview step, so the proposal can go back to approved.
      const kind = classifyFailure(e);
      if (kind === 'refused') { await setProposal(env, row.id, { status: 'failed', submitted_at: null, error: `Upwork refused the proposal: ${errText(e)}` }); return summary; }
      await setProposal(env, row.id, { status: 'approved', submitted_at: null });
      if (kind === 'rate_limit') await patchState(env, { paused: true, pausedReason: `Upwork rate limit or warning while sending: ${errText(e)}` });
      else await countError(env, s, errText(e));
      summary.note = `Preview failed: ${errText(e)}`; return summary;
    }

    const attemptAt = sql(new Date());
    confirmAttempted = true;
    let r: unknown;
    try {
      const tool = state.upwork.toolNames.confirm_preview;
      if (!tool) throw Object.assign(new Error('Upwork confirm tool is missing. Press Check now under Settings → Upwork.'), { notSent: true });
      r = await client.callTool(tool, { action: 'confirm', org_uid: state.upwork.orgUid, params: { type: 'proposal', preview_id: previewId } });
    } catch (e) {
      const notSent = (e as { notSent?: boolean }).notSent === true;
      const kind = notSent ? 'refused' : classifyFailure(e);
      if (kind === 'needs_confirmation') {
        // Upwork wants a person to click: everything goes back to Review (BUILD_PLAN §2); this proposal waits approved.
        await setProposal(env, row.id, { status: 'approved', submitted_at: null, error: null });
        await patchState(env, { mode: 'review', paused: true, pausedReason: 'Upwork asked for a person to confirm proposals. Nothing is sent until you resume.', switchedToReviewReason: `Upwork asked for a person to confirm: ${errText(e)}` });
        summary.note = 'Switched to Review: Upwork asked for a person to confirm.'; return summary;
      }
      if (kind === 'refused') {
        await setProposal(env, row.id, { status: 'failed', submitted_at: null, error: `Upwork refused the proposal: ${errText(e)}` });
        await countError(env, s, errText(e));
        summary.note = `Upwork refused a proposal: ${errText(e)}`;
        return summary;
      }
      if (kind === 'rate_limit') {
        // A 429 or account warning is Upwork turning the request away: not sent. Pause everything until Siv resumes.
        await setProposal(env, row.id, { status: 'approved', submitted_at: null, error: null });
        await patchState(env, { paused: true, pausedReason: `Upwork rate limit or warning while sending: ${errText(e)}` });
        summary.note = 'Paused: Upwork rate limit or warning.'; return summary;
      }
      // Timeout, dropped connection, 5xx: it may have gone through. Never resend; verify on the next runs.
      await setProposal(env, row.id, { status: 'unknown', submitted_at: attemptAt, error: `Unclear answer from Upwork (${errText(e)}); checking, not resending` });
      await countError(env, s, errText(e));
      summary.note = 'Unclear answer from Upwork; checking before anything else is sent.';
      return summary;
    }

    const out = readConfirm(r);
    if (!out.ok) {
      // Upwork answered and said no: nothing was sent.
      const kind = classifyFailure(new Error(out.message));
      if (kind === 'needs_confirmation') {
        await setProposal(env, row.id, { status: 'approved', submitted_at: null, error: null });
        await patchState(env, { mode: 'review', paused: true, pausedReason: 'Upwork asked for a person to confirm proposals. Nothing is sent until you resume.', switchedToReviewReason: `Upwork asked for a person to confirm: ${out.message}` });
        summary.note = 'Switched to Review: Upwork asked for a person to confirm.'; return summary;
      }
      await setProposal(env, row.id, { status: 'failed', submitted_at: null, error: `Upwork refused the proposal: ${out.message}` });
      summary.note = `Upwork refused a proposal: ${out.message}`;
      if (kind === 'rate_limit') await patchState(env, { paused: true, pausedReason: `Upwork rate limit or warning while sending: ${out.message}` });
      else await countError(env, s, out.message);
      return summary;
    }
    await setProposal(env, row.id, { status: 'submitted', submitted_at: attemptAt, upwork_proposal_id: out.proposalId, connects: d.connectsCost, error: null });
    summary.sent = 1; summary.note = `last proposal sent at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: s.caps.timezone })}`;
    const after = await readBalance(client, state).catch(() => null) ?? (balance !== null && d.connectsCost !== null ? balance - d.connectsCost : null);
    await patchState(env, { lastSendAt: new Date().toISOString(), consecutiveErrors: 0, ...(after !== null ? { connectsBalance: after } : {}) });
    await checkConnectsAlert(env, after);
    await env.DB.prepare('UPDATE runs SET submitted = COALESCE(submitted, 0) + 1 WHERE id = (SELECT MAX(id) FROM runs)').run();
    return summary;
  } catch (e) {
    summary.note = `Sender: ${errText(e)}`;
    console.error('sender failed', summary.note);
    // Before the confirm it is safe to retry later; after it, never: the proposal may already be on Upwork.
    if (row) {
      await env.DB.prepare(confirmAttempted
        ? "UPDATE proposals SET status = 'unknown', error = 'Error after sending; checking on Upwork, not resending' WHERE id = ? AND status = 'submitting'"
        : "UPDATE proposals SET status = 'approved', submitted_at = NULL WHERE id = ? AND status = 'submitting'").bind(row.id).run();
    }
    return summary;
  } finally {
    await setNote(env, summary.note);
    await releaseLease(env, 'send');
  }
}
