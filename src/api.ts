import { scanConnection, upworkClient } from './oauth';
import { createPreview } from './pipeline/preview';
import type { Answer } from './pipeline/letter';
import { apifySyncStatus, requestApifySync, syncApify } from './apify';
import { readObject } from './http';
import {
  Env, InvalidInput, loadSettings, loadState, patchState, saveSettings, validateSettings,
} from './settings';
import { checkUpwork, disconnectUpwork, finishUpworkAuth, OAuthError, paramsFromPasted } from './oauth';
import { MissingKey } from './crypto';
import { connectLoom, disconnectLoom, LoomError } from './loom';
import { addJob, recheckMatched } from './pipeline/jobs';
import { checkAnswers, contactDetailsIn, swapLoomLink } from './pipeline/letter';
import { parseAnalysis } from './pipeline/analysis';
import { loadTrackRecord, profileForClaude, syncTrackRecord } from './pipeline/profile';
import { loadAccountStats, refreshAccountStats, resolveRange } from './pipeline/stats';
import { sendDailyReport } from './pipeline/report';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (message: string, status = 400) => json({ error: message }, status);

const PROPOSAL_COLS = `id, job_id, title, url, job_type, budget, client_country, keywords, cover_letter, bid, loom_url,
  connects, boost_connects, score, status, upwork_proposal_id, error, is_example, created_at, submitted_at, create_params, approved_at, approved_via,
  (SELECT reason FROM jobs WHERE jobs.id = proposals.job_id) AS score_reason,
  (SELECT posted_at FROM jobs WHERE jobs.id = proposals.job_id) AS posted_at,
  (SELECT seen_at FROM jobs WHERE jobs.id = proposals.job_id) AS found_at,
  (SELECT analysis FROM jobs WHERE jobs.id = proposals.job_id) AS analysis`;

interface ProposalRow {
  id: number; job_id: string; title: string; url: string | null; job_type: string | null; budget: string | null;
  client_country: string | null; keywords: string | null; cover_letter: string; bid: number | null; loom_url: string | null;
  connects: number | null; boost_connects: number | null; score: number | null; status: string; upwork_proposal_id: string | null; error: string | null;
  is_example: number; created_at: string; submitted_at: string | null; create_params: string | null; score_reason: string | null; analysis: string | null;
  posted_at: string | null; found_at: string | null; approved_at: string | null; approved_via: string | null;
}

const answersOf = (s: string | null): { question: string; answer: string }[] => {
  try { const v = JSON.parse(s ?? '{}').answers; return Array.isArray(v) ? v.map((x) => ({ question: String(x.question), answer: String(x.answer) })) : []; } catch { return []; }
};
const shape = ({ create_params, analysis, ...r }: ProposalRow) => ({
  ...r,
  analysis: parseAnalysis(analysis),
  answers: answersOf(create_params),
  keywords: safeList(r.keywords),
  is_example: r.is_example === 1,
  created_at: toIso(r.created_at),
  submitted_at: toIso(r.submitted_at),
  posted_at: postedIso(r.posted_at),
  found_at: toIso(r.found_at),
  approved_at: toIso(r.approved_at),
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
const toSql = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

// Start of "today" in the given time zone, as a D1 UTC timestamp string
export function dayStartUtc(timeZone: string, now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  const target = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  let candidate = target;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(candidate)).map(x => [x.type, x.value]));
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const next = candidate + target - local;
    if (next === candidate) break;
    candidate = next;
  }
  return toSql(new Date(candidate));
}

// Equal start and end means all day (BUILD_PLAN §11a: 24/7); an end before the start crosses midnight.
export function isActiveNow(start: string, end: string, timeZone: string, now = new Date()): boolean {
  if (start === end) return true;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return start <= end ? hm >= start && hm < end : hm >= start || hm < end;
}

export async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  const method = req.method;

  try {
    // Dashboard mutations require this header to prevent CSRF
    if (method !== 'GET' && req.headers.get('x-dashboard') !== '1') return fail('Missing dashboard header', 403);

    if (path === '/api/state' && method === 'GET') return json(await getState(env));

    if (path === '/api/apify/sync' && method === 'POST') {
      await requestApifySync(env, await loadSettings(env));
      await syncApify(env);
      return json(await apifySyncStatus(env));
    }
    if (path === '/api/settings' && method === 'GET') return json(await loadSettings(env));
    if (path === '/api/settings' && method === 'PUT') {
      const before = await loadSettings(env);
      const s = validateSettings(await readJson(req));
      await saveSettings(env, s);

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
    if (path === '/api/account-stats' && method === 'GET') return json({ stats: await loadAccountStats(env) });
    if (path === '/api/account-stats' && method === 'POST') {
      const state = await loadState(env);
      if (!state.upwork.connected) return fail('Connect Upwork first', 409);
      try {
        const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
        let range;
        try { range = resolveRange(body, (await loadSettings(env)).caps.timezone); } catch (e) { return fail(e instanceof Error ? e.message : 'Unknown period'); }
        return json(await refreshAccountStats(env, range, body.resume === true));
      } catch (e) {
        console.error('account stats failed', e instanceof Error ? e.message : e);
        return fail(e instanceof Error ? e.message : 'Could not read the Upwork account', 502);
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
        const proposal = await env.DB.prepare("SELECT create_params FROM proposals WHERE id = ? AND status = 'pending'").bind(id).first<{ create_params: string }>();
        if (!proposal) return fail('This proposal is no longer waiting for review', 409);
        const answers = answersOf(proposal.create_params);
        const problem = checkAnswers(answers.map(a => a.question), answers);
        if (problem) return fail('Review screening answers: ' + problem);
        const r = await env.DB.prepare("UPDATE proposals SET status = 'approved', error = NULL, approved_at = datetime('now'), approved_via = 'dashboard' WHERE id = ? AND status = 'pending' AND create_params = ?").bind(id, proposal.create_params).run();
        if (!r.meta.changes) return fail('This proposal is no longer waiting for review', 409);
        
        return json({ ok: true, status: 'approved' });
      }
      if (method === 'POST' && action === 'unapprove') {
        const r = await env.DB.prepare("UPDATE proposals SET status = 'pending', approved_at = NULL, approved_via = NULL WHERE id = ? AND status = 'approved'").bind(id).run();
        if (!r.meta.changes) return fail('This proposal is already being sent or was sent', 409);
        return json({ ok: true, status: 'pending' });
      }
      if (method === 'POST' && action === 'skip') {
        const r = await env.DB.prepare("UPDATE proposals SET status = 'skipped' WHERE id = ? AND status IN ('pending', 'approved')").bind(id).run();
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
  const [jobs, props, waiting, approved, examples] = await env.DB.batch<Record<string, number | null>>([
    env.DB.prepare(
      "SELECT COUNT(*) AS scanned, SUM(CASE WHEN status IN ('matched', 'low_score', 'proposed') THEN 1 ELSE 0 END) AS matched FROM jobs WHERE seen_at >= ?",
    ).bind(since),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status = 'submitted' THEN COALESCE(connects, 0) ELSE 0 END) AS connects,
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
    scanConnection: await scanConnection(env),
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
      connectsSpent: p.connects ?? 0,
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
