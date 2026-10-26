import {
  Env, InvalidInput, loadSettings, loadState, patchState, saveSettings, validateSettings,
} from './settings';
import { checkUpwork, disconnectUpwork, finishUpworkAuth, OAuthError, paramsFromPasted } from './oauth';
import { MissingKey } from './crypto';
import { connectLoom, disconnectLoom, LoomError } from './loom';
import { recheckMatched, runScan } from './pipeline/scan';
import { contactDetailsIn, swapLoomLink } from './pipeline/letter';
import { parseAnalysis } from './pipeline/analysis';
import { loadTrackRecord, profileForClaude, syncTrackRecord } from './pipeline/profile';
import { loadAccountStats, refreshAccountStats } from './pipeline/stats';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (message: string, status = 400) => json({ error: message }, status);

const PROPOSAL_COLS = `id, job_id, title, url, job_type, budget, client_country, keywords, cover_letter, bid, loom_url,
  connects, score, status, upwork_proposal_id, error, is_example, created_at, submitted_at, create_params,
  (SELECT reason FROM jobs WHERE jobs.id = proposals.job_id) AS score_reason,
  (SELECT posted_at FROM jobs WHERE jobs.id = proposals.job_id) AS posted_at,
  (SELECT seen_at FROM jobs WHERE jobs.id = proposals.job_id) AS found_at,
  (SELECT analysis FROM jobs WHERE jobs.id = proposals.job_id) AS analysis`;

interface ProposalRow {
  id: number; job_id: string; title: string; url: string | null; job_type: string | null; budget: string | null;
  client_country: string | null; keywords: string | null; cover_letter: string; bid: number | null; loom_url: string | null;
  connects: number | null; score: number | null; status: string; upwork_proposal_id: string | null; error: string | null;
  is_example: number; created_at: string; submitted_at: string | null; create_params: string | null; score_reason: string | null; analysis: string | null;
  posted_at: string | null; found_at: string | null;
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
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = asUtc - now.getTime();
  const midnight = Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset;
  return toSql(new Date(midnight));
}

// Equal start and end means all day (BUILD_PLAN §11a: 24/7); an end before the start crosses midnight.
export function isActiveNow(start: string, end: string, timeZone: string, now = new Date()): boolean {
  if (start === end) return true;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return start <= end ? hm >= start && hm < end : hm >= start || hm < end;
}


export async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  const method = req.method;

  if (method !== 'GET' && req.headers.get('x-dashboard') !== '1') return fail('Missing dashboard header', 403);

  try {
    if (path === '/api/state' && method === 'GET') return json(await getState(env));

    if (path === '/api/settings' && method === 'GET') return json(await loadSettings(env));
    if (path === '/api/settings' && method === 'PUT') {
      const before = await loadSettings(env);
      const s = validateSettings(await readJson(req));
      await saveSettings(env, s);
      await recheckMatched(env, s);
      // A new source video also goes into letters that have not been sent yet.
      if (s.loom.sourceUrl && s.loom.sourceUrl !== before.loom.sourceUrl) await relinkQueued(env, s.loom.sourceUrl);
      return json(s);
    }

    if (path === '/api/proposals/relink-loom' && method === 'POST') {
      const s = await loadSettings(env);
      if (!s.loom.sourceUrl) return fail('Set the Loom video link in Settings first');
      return json({ updated: await relinkQueued(env, s.loom.sourceUrl) });
    }

    if (path === '/api/mode' && method === 'POST') {
      const body = await readJson(req);
      if (body.mode === 'review') return json(await patchState(env, { mode: 'review' }));
      if (body.mode === 'auto') {
        if (body.confirm !== true) return fail('Confirm the switch to Auto mode');
        const state = await loadState(env);
        if (!state.upwork.connected) return fail('Connect Upwork before turning on Auto mode', 409);
        return json(await patchState(env, { mode: 'auto', switchedToReviewReason: null }));
      }
      return fail('Mode must be review or auto');
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
        return json(await refreshAccountStats(env, Number(body.days) || 30, body.resume === true));
      } catch (e) {
        console.error('account stats failed', e instanceof Error ? e.message : e);
        return fail(e instanceof Error ? e.message : 'Could not read the Upwork account', 502);
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
      const { results } = await env.DB.prepare(
        `SELECT ${PROPOSAL_COLS} FROM proposals WHERE status = 'pending' ORDER BY COALESCE(found_at, created_at) DESC, created_at DESC LIMIT 100`,
      ).all<ProposalRow>();
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

    if (path === '/api/scan' && method === 'POST') {
      const state = await loadState(env);
      if (!state.upwork.connected) return fail('Connect Upwork first', 409);
      if (state.paused) return fail('Bidding is paused. Resume it to scan.', 409);
      const summary = await runScan(env, { force: true });
      if (!summary) return fail('A scan is already running. Try again in a minute.', 409);
      return json(summary);
    }

    const m = path.match(/^\/api\/proposals\/(\d+)(?:\/(approve|skip|unapprove))?$/);
    if (m) {
      const id = Number(m[1]);
      const action = m[2];
      if (!action && method === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.cover_letter !== 'string') return fail('cover_letter must be text');
        const letter = body.cover_letter.trim();
        if (!letter) return fail('The cover letter is empty');
        if (letter.length > 5000) return fail(`The letter is ${letter.length} characters. Upwork allows 5,000.`);
        const found = contactDetailsIn(letter.replaceAll(/https:\/\/(www\.)?loom\.com\/share\/\S+/g, ''));
        if (found) return fail(`Remove ${found} from the letter. Upwork does not allow contact details in proposals.`);
        // The bid can be changed per proposal on review (Celia, Oct 26); the sender uses this column.
        let bid: number | null = null;
        if (body.bid !== undefined) {
          bid = Number(body.bid);
          if (!Number.isFinite(bid) || bid < 1 || bid > 10000) return fail('The bid must be a number between 1 and 10,000');
          bid = Math.round(bid * 100) / 100;
        }
        const r = await env.DB.prepare("UPDATE proposals SET cover_letter = ?, bid = COALESCE(?, bid) WHERE id = ? AND status = 'pending'").bind(letter, bid, id).run();
        if (!r.meta.changes) return fail('This proposal is no longer waiting for review', 409);
        return json({ ok: true });
      }
      if (method === 'POST' && action === 'approve') {
        const r = await env.DB.prepare("UPDATE proposals SET status = 'approved', error = NULL WHERE id = ? AND status = 'pending'").bind(id).run();
        if (!r.meta.changes) return fail('This proposal is no longer waiting for review', 409);
        return json({ ok: true, status: 'approved' });
      }
      if (method === 'POST' && action === 'unapprove') {
        const r = await env.DB.prepare("UPDATE proposals SET status = 'pending' WHERE id = ? AND status = 'approved'").bind(id).run();
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
    if (e instanceof InvalidInput) return fail(e.message);
    if (e instanceof SyntaxError) return fail('The request body is not valid JSON');
    console.error(e);
    return fail('Something went wrong on the server. Check the Worker logs.', 500);
  }
}

// Pending and approved proposals only: anything sending or sent keeps the letter Upwork has. Letters with their own Loom
// copy (M5) keep it.
async function relinkQueued(env: Env, loomUrl: string): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, cover_letter FROM proposals WHERE status IN ('pending', 'approved') AND is_example = 0 AND loom_video_id IS NULL")
    .all<{ id: number; cover_letter: string }>();
  const updates = results.flatMap((r) => {
    const next = swapLoomLink(r.cover_letter, loomUrl);
    return next === r.cover_letter ? [] : [env.DB.prepare("UPDATE proposals SET cover_letter = ?, loom_url = ? WHERE id = ? AND status IN ('pending', 'approved')").bind(next, loomUrl, r.id)];
  });
  if (updates.length) await env.DB.batch(updates);
  return updates.length;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > 64_000) throw new InvalidInput('Request is too large');
  const body = await req.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new InvalidInput('Expected a JSON object');
  return body as Record<string, unknown>;
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
    lastScanAt: state.lastScanAt,
    scanEveryMinutes: settings.scanEveryMinutes,
    activeNow: isActiveNow(settings.caps.activeStart, settings.caps.activeEnd, settings.caps.timezone),
    sendingEnabled: settings.sendingEnabled,
    connectsAlertBelow: settings.connectsAlertBelow,
    activeHours: { start: settings.caps.activeStart, end: settings.caps.activeEnd, timezone: settings.caps.timezone },
    caps: { daily: settings.caps.daily, hourly: settings.caps.hourly, gapMinutes: settings.caps.gapMinutes, connectsFloor: settings.caps.connectsFloorEnabled ? settings.caps.connectsFloor : 0 },
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
  const cols = ['posted_at', 'found_at', 'created_at', 'submitted_at', 'status', 'title', 'url', 'job_type', 'budget', 'score', 'connects', 'bid', 'loom_url', 'upwork_proposal_id', 'error'] as const;
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
