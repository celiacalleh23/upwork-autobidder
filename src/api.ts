import {
  Env, InvalidInput, loadSettings, loadState, patchState, saveSettings, validateSettings,
} from './settings';
import { checkUpwork, disconnectUpwork, finishUpworkAuth, OAuthError, paramsFromPasted } from './oauth';
import { MissingKey } from './crypto';
import { runScan } from './pipeline/scan';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (message: string, status = 400) => json({ error: message }, status);

const PROPOSAL_COLS = `id, job_id, title, url, job_type, budget, client_country, keywords, cover_letter, bid, loom_url,
  connects, score, status, upwork_proposal_id, error, is_example, created_at, submitted_at`;

interface ProposalRow {
  id: number; job_id: string; title: string; url: string | null; job_type: string | null; budget: string | null;
  client_country: string | null; keywords: string | null; cover_letter: string; bid: number | null; loom_url: string | null;
  connects: number | null; score: number | null; status: string; upwork_proposal_id: string | null; error: string | null;
  is_example: number; created_at: string; submitted_at: string | null;
}

const shape = (r: ProposalRow) => ({
  ...r,
  keywords: safeList(r.keywords),
  is_example: r.is_example === 1,
  created_at: toIso(r.created_at),
  submitted_at: toIso(r.submitted_at),
});
const safeList = (s: string | null): string[] => {
  try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};
// D1 stores datetime('now') as "YYYY-MM-DD HH:MM:SS" in UTC
const toIso = (s: string | null) => (s ? s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z') : null);
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

export function isActiveNow(start: string, end: string, timeZone: string, now = new Date()): boolean {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return start <= end ? hm >= start && hm < end : hm >= start || hm < end;
}

// Contact details are not allowed in Upwork cover letters
export function contactDetailsIn(text: string): string | null {
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) return 'an email address';
  const phoneLike = text.match(/\+?\d[\d\s().-]{8,}\d/g) ?? [];
  if (phoneLike.some((m) => m.replace(/\D/g, '').length >= 10)) return 'a phone number';
  if (/(wa\.me|whatsapp|telegram|t\.me\/|skype|calendly\.com|linkedin\.com|instagram\.com|@[A-Za-z0-9_]{3,}\b)/i.test(text)) return 'a social handle or outside contact link';
  return null;
}

export async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  const method = req.method;

  if (method !== 'GET' && req.headers.get('x-dashboard') !== '1') return fail('Missing dashboard header', 403);

  try {
    if (path === '/api/state' && method === 'GET') return json(await getState(env));

    if (path === '/api/settings' && method === 'GET') return json(await loadSettings(env));
    if (path === '/api/settings' && method === 'PUT') {
      const s = validateSettings(await readJson(req));
      await saveSettings(env, s);
      return json(s);
    }

    if (path === '/api/mode' && method === 'POST') {
      const body = await readJson(req);
      if (body.mode === 'review') return json(await patchState(env, { mode: 'review' }));
      if (body.mode === 'auto') {
        if (body.confirm !== true) return fail('Confirm the switch to Auto mode');
        const state = await loadState(env);
        if (!state.upwork.connected) return fail('Connect Upwork before turning on Auto mode', 409);
        return json(await patchState(env, { mode: 'auto' }));
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
        `SELECT ${PROPOSAL_COLS} FROM proposals WHERE status = 'pending' ORDER BY score DESC, created_at ASC LIMIT 100`,
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
        `SELECT id, title, url, job_type, budget, client_country, posted_at, seen_at, status, reason, score FROM jobs ${where}
         ORDER BY seen_at DESC, posted_at DESC LIMIT ? OFFSET ?`,
      );
      const { results } = await (where ? stmt.bind(status, limit + 1, offset) : stmt.bind(limit + 1, offset)).all();
      return json({ rows: results.slice(0, limit), hasMore: results.length > limit });
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
        const r = await env.DB.prepare("UPDATE proposals SET cover_letter = ? WHERE id = ? AND status = 'pending'").bind(letter, id).run();
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
    activeHours: { start: settings.caps.activeStart, end: settings.caps.activeEnd, timezone: settings.caps.timezone },
    caps: { daily: settings.caps.daily, hourly: settings.caps.hourly, gapMinutes: settings.caps.gapMinutes, connectsFloor: settings.caps.connectsFloor },
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
  const cols = ['created_at', 'submitted_at', 'status', 'title', 'url', 'job_type', 'budget', 'score', 'connects', 'bid', 'loom_url', 'upwork_proposal_id', 'error'] as const;
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
