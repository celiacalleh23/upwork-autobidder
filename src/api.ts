import { discoveryRunHistory } from './pipeline/scan';
import { scanConnection, upworkClient } from './oauth';
import { createPreview } from './pipeline/preview';
import type { Answer } from './pipeline/letter';
import { apifyRunHistory, apifySyncStatus, requestApifySync, syncApify } from './apify';
import { readObject } from './http';
import {
  Env, InvalidInput, loadSettings, loadState, patchState, saveSettings, validateSettings,
} from './settings';
import { checkUpwork, disconnectUpwork, finishUpworkAuth, OAuthError, paramsFromPasted } from './oauth';
import { MissingKey } from './crypto';
import { connectLoom, disconnectLoom, LoomError } from './loom';
import { addJob, recheckMatched } from './pipeline/jobs';
import { checkAnswers, contactDetailsIn, metaLanguageIn, swapLoomLink } from './pipeline/letter';
import { rewriteLetter } from './claude';
import { recoverSubmittedRows } from './pipeline/submitted';
import { parseAnalysis } from './pipeline/analysis';
import { loadTrackRecord, profileForClaude, syncTrackRecord } from './pipeline/profile';
import { loadLocalAccount, resolveRange } from './pipeline/stats';
import { sendDailyReport } from './pipeline/report';
import { displayNote } from './pipeline/proposalNote';
import { dayStartUtc, loadMonthConnects, loadTodayConnects } from './pipeline/connectsReport';
export { dayStartUtc };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (message: string, status = 400) => json({ error: message }, status);

const PROPOSAL_COLS = `id, job_id, title, url, job_type, budget, client_country, keywords, cover_letter, bid, loom_url,
  connects, boost_connects, score, status, upwork_proposal_id, error, is_example, created_at, submitted_at, create_params, approved_at, approved_via,
  skipped_at, skipped_by,
  (SELECT json_extract(value, '$.note') FROM kv WHERE key = 'boost:decision:' || proposals.id) AS boost_note,
  (SELECT reason FROM jobs WHERE jobs.id = proposals.job_id) AS score_reason,
  (SELECT posted_at FROM jobs WHERE jobs.id = proposals.job_id) AS posted_at,
  (SELECT seen_at FROM jobs WHERE jobs.id = proposals.job_id) AS found_at,
  (SELECT analysis FROM jobs WHERE jobs.id = proposals.job_id) AS analysis`;

interface ProposalRow {
  id: number; job_id: string; title: string; url: string | null; job_type: string | null; budget: string | null;
  client_country: string | null; keywords: string | null; cover_letter: string; bid: number | null; loom_url: string | null;
  connects: number | null; boost_connects: number | null; boost_note: string | null; score: number | null; status: string; upwork_proposal_id: string | null; error: string | null;
  is_example: number; created_at: string; submitted_at: string | null; create_params: string | null; score_reason: string | null; analysis: string | null;
  posted_at: string | null; found_at: string | null; approved_at: string | null; approved_via: string | null;
  skipped_at: string | null; skipped_by: string | null;
}

const answersOf = (s: string | null): { question: string; answer: string }[] => {
  try { const v = JSON.parse(s ?? '{}').answers; return Array.isArray(v) ? v.map((x) => ({ question: String(x.question), answer: String(x.answer) })) : []; } catch { return []; }
};
const draftFields = (s: string | null): { bidBasis: string | null; missing: string[] } => {
  try {
    const v = JSON.parse(s ?? '{}') as { bid_basis?: unknown; missing?: unknown };
    return {
      bidBasis: typeof v.bid_basis === 'string' ? v.bid_basis : null,
      missing: Array.isArray(v.missing) ? v.missing.filter((item): item is string => typeof item === 'string') : [],
    };
  } catch { return { bidBasis: null, missing: [] }; }
};
const shownStatus = (status: string, proposalId: string | null) => proposalId && (status === 'submitting' || status === 'sending') ? 'submitted' : status;
const shape = ({ create_params, analysis, ...r }: ProposalRow) => ({
  ...r,
  status: shownStatus(r.status, r.upwork_proposal_id),
  analysis: parseAnalysis(analysis),
  answers: answersOf(create_params),
  ...(() => { const note = displayNote({ error: r.error, status: shownStatus(r.status, r.upwork_proposal_id), ...draftFields(create_params) }); return { note: note.text, note_error: note.error }; })(),
  keywords: safeList(r.keywords),
  is_example: r.is_example === 1,
  created_at: toIso(r.created_at),
  submitted_at: toIso(r.submitted_at),
  posted_at: postedIso(r.posted_at),
  found_at: toIso(r.found_at),
  approved_at: toIso(r.approved_at),
  skipped_at: toIso(r.skipped_at),
});
const safeList = (s: string | null): string[] => {
  try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};
// D1 stores datetime('now') as "YYYY-MM-DD HH:MM:SS" in UTC
const toIso = (s: string | null) => (s ? s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z') : null);
// Upwork's published date comes as ISO text, or as "YYYY-MM-DD HH:MM:SS" in UTC like D1's; null when unreadable.
export function postedIso(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(/T/.test(s) ? s : `${s.trim().replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
// Equal start and end means all day (BUILD_PLAN §11a: 24/7); an end before the start crosses midnight.
export function isActiveNow(start: string, end: string, timeZone: string, now = new Date()): boolean {
  if (start === end) return true;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return start <= end ? hm >= start && hm < end : hm >= start || hm < end;
}

export async function handleApi(req: Request, env: Env, path: string, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const method = req.method;

  try {
    // Dashboard mutations require this header to prevent CSRF
    if (method !== 'GET' && req.headers.get('x-dashboard') !== '1') return fail('Missing dashboard header', 403);

    if (path === '/api/state' && method === 'GET') return json(await getState(env));

    if (path === '/api/connects-report' && method === 'GET') return json(await loadMonthConnects(env));

    if (path === '/api/apify/status' && method === 'GET') return json(await apifySyncStatus(env));

    if (path === '/api/apify/sync' && method === 'POST') {
      await requestApifySync(env, await loadSettings(env));
      const work = syncApify(env);
      if (ctx) ctx.waitUntil(work.catch(() => console.error('Apify background sync failed; persisted request will retry')));
      else await work;
      return json(await apifySyncStatus(env), ctx ? 202 : 200);
    }
    if (path === '/api/settings' && method === 'GET') return json(await loadSettings(env));
    if (path === '/api/settings' && method === 'PUT') {
      const before = await loadSettings(env);
      const s = validateSettings(await readJson(req));
      await saveSettings(env, s);
      if (ctx) ctx.waitUntil(syncApify(env).catch(() => console.error('Apify background sync failed; persisted request will retry')));

      if (s.sendingEnabled !== before.sendingEnabled) {
        await patchState(env, { senderNote: s.sendingEnabled ? 'the next approved proposal goes out within 5 minutes' : null });
      }
      await recheckMatched(env, s);
      if (s.loom.sourceUrl && s.loom.sourceUrl !== before.loom.sourceUrl) await relinkQueued(env, s.loom.sourceUrl);
      return json(s);
    }

    if (path === '/api/proposals/relink-loom' && method === 'POST') {
      const settings = await loadSettings(env);
      if (!settings.loom.sourceUrl) return fail('Set the Loom video link in Settings first');
      return json({ updated: await relinkQueued(env, settings.loom.sourceUrl), done: true });
    }

    if (path === '/api/mode' && method === 'POST') {
      const body = await readJson(req);
      if (body.mode === 'review') {
        const state = await patchState(env, { mode: 'review' });
        await env.DB.prepare("UPDATE proposals SET status = 'pending', approved_at = NULL, approved_via = NULL WHERE status = 'approved' AND approved_via = 'auto-submit'").run();
        return json(state);
      }
      if (body.mode === 'auto') {
        if (body.confirm !== true) return fail('Confirm the switch to Auto mode');
        const state = await loadState(env);
        if (!state.upwork.connected) return fail('Connect Upwork before turning on Auto mode', 409);
        return json(await patchState(env, { mode: 'auto', switchedToReviewReason: null }));
      }
      return fail('Mode must be review or auto');
    }

    if (path === '/api/upwork/scan/finish' && method === 'POST') {
      const body = await readJson(req);
      await finishUpworkAuth(env, paramsFromPasted(String(body.url ?? '')), 'scan');
      const st = await checkUpwork(env, 'scan');
      return json({ok:true,account:st.upwork.account});
    }
    if (path === '/api/upwork/scan/check' && method === 'POST') {
      const st = await checkUpwork(env, 'scan'); return json({ok:true,account:st.upwork.account});
    }
    if (path === '/api/upwork/scan/disconnect' && method === 'POST') {
      await disconnectUpwork(env, 'scan'); return json({ok:true});
    }
    if (path === '/api/upwork/check' && method === 'POST') {
      try {
        await checkUpwork(env);
        return json({ ok: true });
      } catch (e) {
        console.error('upwork check failed', e instanceof Error ? e.message : e);
        return fail(e instanceof Error ? e.message : 'Upwork check failed', 502);
      }
    }
    if (path === '/api/upwork/finish' && method === 'POST') {
      const body = await readJson(req);
      try {
        await finishUpworkAuth(env, paramsFromPasted(String(body.url ?? '')));
      } catch (e) {
        if (e instanceof OAuthError || e instanceof MissingKey) return fail(e.message);
        throw e;
      }
      try {
        const s = await checkUpwork(env);
        return json({ ok: true, account: s.upwork.account });
      } catch (e) {
        return json({ ok: true, account: null, warning: e instanceof Error ? e.message : 'Account details could not be read yet' });
      }
    }
    if (path === '/api/profile' && method === 'GET') {
      const [record, s] = await Promise.all([loadTrackRecord(env), loadSettings(env)]);
      return json({ record, profileText: profileForClaude(record, s) });
    }
    if (path === '/api/profile/sync' && method === 'POST') {
      const state = await loadState(env);
      if (!state.upwork.connected) return fail('Connect Upwork first', 409);
      try {
        return json({ record: await syncTrackRecord(env) });
      } catch (e) {
        console.error('profile sync failed', e instanceof Error ? e.message : e);
        return fail(e instanceof Error ? e.message : 'Could not read the Upwork profile', 502);
      }
    }
    if (path === '/api/account-stats' && (method === 'GET' || method === 'POST')) {
      try {
        const url = new URL(req.url);
        const body = method === 'POST' ? await readJson(req).catch(() => ({} as Record<string, unknown>)) : {};
        const input = {
          range: body.range ?? url.searchParams.get('range') ?? body.days ?? url.searchParams.get('days') ?? '30',
          from: body.from ?? url.searchParams.get('from') ?? undefined,
          to: body.to ?? url.searchParams.get('to') ?? undefined,
        };
        const range = resolveRange(input, (await loadSettings(env)).caps.timezone);
        return json({ stats: await loadLocalAccount(env, range), done: true, phase: 'records' });
      } catch (e) {
        if (e instanceof RangeError) return fail(e.message);
        console.error('account stats failed', e instanceof Error ? e.message : e);
        return fail(e instanceof Error ? e.message : 'Could not read the account records', 500);
      }
    }
    if (path === '/api/report/test' && method === 'POST') {
      try {
        return json(await sendDailyReport(env, { force: true }));
      } catch (e) {
        return fail(e instanceof Error ? e.message : 'The report could not be sent', 502);
      }
    }
    if (path === '/api/loom/connect' && method === 'POST') {
      const body = await readJson(req);
      const s = await loadSettings(env);
      try {
        return json(await connectLoom(env, String(body.session ?? ''), s.loom.sourceUrl, body.expires));
      } catch (e) {
        if (e instanceof LoomError || e instanceof MissingKey) return fail(e.message, 400);
        throw e;
      }
    }
    if (path === '/api/loom/disconnect' && method === 'POST') return json(await disconnectLoom(env));

    if (path === '/api/upwork/disconnect' && method === 'POST') {
      await disconnectUpwork(env);
      return json({ ok: true });
    }

    if (path === '/api/pause' && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.paused !== 'boolean') return fail('paused must be true or false');
      return json(await patchState(env, body.paused
        ? { paused: true, pausedReason: 'Paused from the dashboard' }
        : { paused: false, pausedReason: null, consecutiveErrors: 0 }));
    }

    if (path === '/api/queue' && method === 'GET') {
      const { results } = await env.DB.prepare(`SELECT ${PROPOSAL_COLS} FROM proposals
        WHERE status = 'pending' ORDER BY created_at DESC LIMIT 100`).all<ProposalRow>();
      return json(results.map(shape));
    }

    if (path === '/api/log' && method === 'GET') {
      await recoverSubmittedRows(env);
      const url = new URL(req.url);
      const status = url.searchParams.get('status');
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      const allowed = ['approved', 'submitted', 'failed', 'skipped', 'unknown', 'pending'];
      const where = status && allowed.includes(status) ? 'WHERE status = ?' : '';
      const stmt = env.DB.prepare(`SELECT ${PROPOSAL_COLS} FROM proposals ${where} ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT ? OFFSET ?`);
      const { results } = await (where ? stmt.bind(status, limit + 1, offset) : stmt.bind(limit + 1, offset)).all<ProposalRow>();
      return json({ rows: results.slice(0, limit).map(shape), hasMore: results.length > limit });
    }

    if (path === '/api/log.csv' && method === 'GET') return csv(env);

    if (path === '/api/jobs' && method === 'GET') {
      const url = new URL(req.url);
      const status = url.searchParams.get('status');
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      const allowed = ['matched', 'filtered', 'low_score', 'proposed', 'error'];
      const where = status && allowed.includes(status) ? 'WHERE status = ?' : '';
      const stmt = env.DB.prepare(
        `SELECT id, title, url, job_type, budget, client_country, posted_at, seen_at, status, reason, score, analysis FROM jobs ${where}
         ORDER BY seen_at DESC, posted_at DESC LIMIT ? OFFSET ?`,
      );
      const { results } = await (where ? stmt.bind(status, limit + 1, offset) : stmt.bind(limit + 1, offset)).all();
      return json({ rows: results.slice(0, limit).map((r) => ({ ...r, analysis: parseAnalysis(r.analysis as string | null) })), hasMore: results.length > limit });
    }

    if (path === '/api/jobs' && method === 'POST') {
      const body = await readJson(req);
      const r = await addJob(env, { jobUrl: body.jobUrl });
      return r.ok ? json(r) : fail(r.reason);
    }

    const m = path.match(/^\/api\/proposals\/(\d+)(?:\/(approve|skip|unapprove|refresh-questions|resolve-unknown))?$/);
    if (m) {
      const id = Number(m[1]);
      const action = m[2];
      if (action === 'resolve-unknown' && method === 'POST') {
        const body = await readJson(req);
        if (body.confirm !== true || !['submitted', 'not_sent'].includes(String(body.outcome))) return fail('Check the proposal on Upwork first, then explicitly confirm its outcome');
        if (body.outcome === 'not_sent') {
          const open = await env.DB.prepare("SELECT preview_id, upwork_proposal_id, approved_via FROM proposals WHERE id = ? AND status = 'unknown'")
            .bind(id).first<{ preview_id: string | null; upwork_proposal_id: string | null; approved_via: string | null }>();
          if (!open) return fail('This proposal is no longer awaiting verification', 409);
          if (!open.preview_id && !open.upwork_proposal_id) {
            const via = open.approved_via || 'dashboard';
            const restored = await env.DB.prepare("UPDATE proposals SET status = 'approved', submitted_at = NULL, error = NULL, approved_via = ?, approved_at = COALESCE(approved_at, datetime('now')) WHERE id = ? AND status = 'unknown'")
              .bind(via, id).run();
            return restored.meta.changes ? json({ ok: true, status: 'approved' }) : fail('This proposal is no longer awaiting verification', 409);
          }
        }
        const status = body.outcome === 'submitted' ? 'submitted' : 'failed';
        const reference = body.proposalId === undefined ? null : String(body.proposalId).slice(0, 100);
        const r = await env.DB.prepare("UPDATE proposals SET status = ?, upwork_proposal_id = COALESCE(?, upwork_proposal_id), submitted_at = COALESCE(submitted_at, datetime('now')), error = ? WHERE id = ? AND status = 'unknown'")
          .bind(status, reference, status === 'submitted' ? 'Manually confirmed on Upwork from the dashboard' : 'Manually checked on Upwork: not sent. No automatic retry.', id).run();
        return r.meta.changes ? json({ ok: true }) : fail('This proposal is no longer awaiting verification', 409);
      }
      if (action === 'refresh-questions' && method === 'POST') {
        const row = await env.DB.prepare("SELECT job_id, cover_letter, bid, job_type, create_params FROM proposals WHERE id = ? AND status = 'pending'").bind(id)
          .first<{ job_id: string; cover_letter: string; bid: number; job_type: string; create_params: string }>();
        if (!row) return fail('This proposal is no longer waiting for review', 409);
        const state = await loadState(env);
        if (state.paused) return fail('Resume after reviewing the pause reason before refreshing Upwork data', 409);
        const client = await upworkClient(env);
        const preview = await createPreview(client, state, { jobId: row.job_id, letter: row.cover_letter, bid: row.bid, fixed: row.job_type === 'fixed' });
        if (preview.questions === null) return fail('Upwork did not return screening questions. Nothing was changed.');
        const params = JSON.parse(row.create_params || '{}');
        const old = Array.isArray(params.answers) ? params.answers as Answer[] : [];
        params.answers = preview.questions.map(question => ({ question, answer: old.find(a => a.question === question)?.answer ?? '' }));
        const updated = await env.DB.prepare("UPDATE proposals SET create_params = ?, error = 'Screening questions refreshed; edit the answers and review again.' WHERE id = ? AND status = 'pending' AND create_params = ? AND cover_letter = ? AND bid IS ?")
          .bind(JSON.stringify(params), id, row.create_params, row.cover_letter, row.bid).run();
        return updated.meta.changes ? json({ ok: true }) : fail('Proposal changed while refreshing; reload', 409);
      }
      if (!action && method === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.cover_letter !== 'string') return fail('cover_letter must be text');
        const letter = body.cover_letter.trim();
        if (!letter) return fail('The cover letter is empty');
        if (letter.length > 5000) return fail(`The letter is ${letter.length} characters. Upwork allows 5,000.`);
        const found = contactDetailsIn(letter.replaceAll(/https:\/\/(www\.)?loom\.com\/share\/\S+/g, ''));
        if (found) return fail(`Remove ${found} from the letter. Upwork does not allow contact details in proposals.`);
        let bid: number | null = null;
        if (body.bid !== undefined) {
          bid = Number(body.bid);
          if (!Number.isFinite(bid) || bid < 1 || bid > 10000) return fail('The bid must be a number between 1 and 10,000');
          bid = Math.round(bid * 100) / 100;
        }
        const stored = await env.DB.prepare("SELECT create_params FROM proposals WHERE id = ? AND status = 'pending'").bind(id).first<{ create_params: string }>();
        if (!stored) return fail('This proposal is no longer waiting for review', 409);
        const params = JSON.parse(stored.create_params || '{}');
        if (body.answers !== undefined) {
          if (!Array.isArray(body.answers)) return fail('Answers must be a list');
          const questions = answersOf(stored.create_params).map(a => a.question);
          const answers = body.answers.map(v => ({ question: String((v as Answer)?.question ?? ''), answer: String((v as Answer)?.answer ?? '').trim() }));
          const problem = checkAnswers(questions, answers);
          if (problem || answers.some((a, i) => a.question !== questions[i])) return fail(problem ?? 'Questions changed; refresh and review again');
          params.answers = answers;
        }
        const r = await env.DB.prepare("UPDATE proposals SET cover_letter = ?, bid = COALESCE(?, bid), create_params = ? WHERE id = ? AND status = 'pending' AND create_params = ?")
          .bind(letter, bid, JSON.stringify(params), id, stored.create_params).run();
        if (!r.meta.changes) return fail('This proposal is no longer waiting for review', 409);
        return json({ ok: true });
      }
      if (method === 'POST' && action === 'approve') {
        const proposal = await env.DB.prepare("SELECT job_id, cover_letter, job_type, bid, create_params FROM proposals WHERE id = ? AND status = 'pending'").bind(id).first<{ job_id: string; cover_letter: string; job_type: string | null; bid: number | null; create_params: string }>();
        if (!proposal) return fail('This proposal is no longer waiting for review', 409);
        let letter = proposal.cover_letter;
        const meta = metaLanguageIn(letter);
        if (meta) {
          let cleaned: string | null = null;
          try { cleaned = await rewriteLetter(env, letter, meta); } catch { cleaned = null; }
          if (!cleaned || metaLanguageIn(cleaned)) return fail(`The letter contains ${meta}. It was not approved.`);
          letter = cleaned;
        }
        const r = await env.DB.prepare("UPDATE proposals SET status = 'approved', cover_letter = ?, error = NULL, approved_at = datetime('now'), approved_via = 'dashboard' WHERE id = ? AND status = 'pending' AND create_params = ?").bind(letter, id, proposal.create_params).run();
        if (!r.meta.changes) return fail('This proposal is no longer waiting for review', 409);
        // The sender runs on the cron. Starting it from this request gets cancelled after the response, which can
        // leave the row claimed as sending before a preview exists.
        return json({ ok: true, status: 'approved' });
      }
      if (method === 'POST' && action === 'unapprove') {
        const r = await env.DB.prepare("UPDATE proposals SET status = 'pending', approved_at = NULL, approved_via = NULL WHERE id = ? AND status = 'approved'").bind(id).run();
        if (!r.meta.changes) return fail('This proposal is already being sent or was sent', 409);
        return json({ ok: true, status: 'pending' });
      }
      if (method === 'POST' && action === 'skip') {
        // The session cookie proves a signed-in dashboard user and carries no person name, so skipped_by stays empty.
        const r = await env.DB.prepare("UPDATE proposals SET status = 'skipped', skipped_at = datetime('now'), skipped_by = NULL WHERE id = ? AND status IN ('pending', 'approved')").bind(id).run();
        if (!r.meta.changes) return fail('This proposal is no longer waiting', 409);
        return json({ ok: true, status: 'skipped' });
      }
    }

    if (path === '/api/examples' && method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM proposals WHERE is_example = 1'),
        env.DB.prepare("DELETE FROM jobs WHERE reason = 'example'"),
      ]);
      return json({ ok: true });
    }

    return fail('Not found', 404);
  } catch (e) {
    if (e instanceof InvalidInput || e instanceof OAuthError || e instanceof MissingKey) return fail(e.message);
    if (e instanceof SyntaxError) return fail('The request body is not valid JSON');
    console.error(e);
    return fail('Something went wrong on the server. Check the Worker logs.', 500);
  }
}

async function relinkQueued(env: Env, loomUrl: string): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, cover_letter FROM proposals WHERE status = 'pending' AND is_example = 0 AND loom_video_id IS NULL")
    .all<{ id: number; cover_letter: string }>();
  const updates = results.flatMap((r) => {
    const next = swapLoomLink(r.cover_letter, loomUrl);
    return next === r.cover_letter ? [] : [env.DB.prepare("UPDATE proposals SET cover_letter = ?, loom_url = ? WHERE id = ? AND status = 'pending' AND cover_letter = ?").bind(next, loomUrl, r.id, r.cover_letter)];
  });
  if (updates.length) await env.DB.batch(updates);
  return updates.length;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  return readObject(req);
}

async function getState(env: Env) {
  const [state, settings] = await Promise.all([loadState(env), loadSettings(env)]);
  const since = dayStartUtc(settings.caps.timezone);
  const todaySpend = await loadTodayConnects(env);
  const [jobs, props, waiting, approved, examples] = await env.DB.batch<Record<string, number | null>>([
    env.DB.prepare(
      "SELECT COUNT(*) AS scanned, SUM(CASE WHEN status IN ('matched', 'low_score', 'proposed') THEN 1 ELSE 0 END) AS matched FROM jobs WHERE seen_at >= ?",
    ).bind(since),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status IN ('failed', 'unknown') THEN 1 ELSE 0 END) AS failed
       FROM proposals WHERE COALESCE(submitted_at, created_at) >= ?`,
    ).bind(since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'approved'"),
    env.DB.prepare('SELECT COUNT(*) AS n FROM proposals WHERE is_example = 1'),
  ]);
  const j = jobs.results[0] ?? {};
  const p = props.results[0] ?? {};
  return {
    ...state,
    apifySync: await apifySyncStatus(env),
    apifyRuns: await apifyRunHistory(env),
    discoveryRuns: await discoveryRunHistory(env),
    scanConnection: await scanConnection(env),
    scanAccountDisabled: env.SCAN_ACCOUNT_DISABLED === 'true',
    discovery: { bidding: await getDiscovery(env, 'discovery:lastScan'), scan: await getDiscovery(env, 'discovery:lastScan:scan') },
    lastScanAt: state.lastScanAt,
    lastRun: await env.DB.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").first(),
    activeNow: isActiveNow(settings.caps.activeStart, settings.caps.activeEnd, settings.caps.timezone),
    sendingEnabled: settings.sendingEnabled,
    connectsAlertBelow: settings.connectsAlertBelow,
    activeHours: { start: settings.caps.activeStart, end: settings.caps.activeEnd, timezone: settings.caps.timezone },
    caps: { daily: settings.caps.daily, hourly: settings.caps.hourly, gapMinutes: settings.caps.gapMinutes, connectsFloor: settings.caps.connectsFloorEnabled ? settings.caps.connectsFloor : 0 },
    boost: { inAuto: settings.caps.boostInAuto, minScore: settings.caps.boostMinScore, maxConnects: settings.caps.boostMaxConnects },
    today: {
      scanned: j.scanned ?? 0,
      matched: j.matched ?? 0,
      sent: p.sent ?? 0,
      connectsSpent: todaySpend.total.connects,
      connectsBoost: todaySpend.boosts.connects,
      connectsRefunded: todaySpend.refunds.connects,
      connectsReceived: todaySpend.received.connects,
      failed: p.failed ?? 0,
      waiting: waiting.results[0]?.n ?? 0,
      approved: approved.results[0]?.n ?? 0,
    },
    hasExamples: (examples.results[0]?.n ?? 0) > 0,
  };
}

async function csv(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT ${PROPOSAL_COLS} FROM proposals ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT 5000`,
  ).all<ProposalRow>();
  const cols = ['posted_at', 'found_at', 'created_at', 'submitted_at', 'status', 'title', 'url', 'job_type', 'budget', 'score', 'connects', 'boost_connects', 'bid', 'loom_url', 'upwork_proposal_id', 'error'] as const;
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection from job titles
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [cols.join(','), ...results.map((r) => cols.map((c) => cell((shape(r) as Record<string, unknown>)[c])).join(','))];
  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="upwork-proposals-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

async function getDiscovery(env: Env, key: string) { const row = await env.DB.prepare('SELECT value FROM kv WHERE key=?').bind(key).first<{value:string}>(); return row ? JSON.parse(row.value) : null; }
