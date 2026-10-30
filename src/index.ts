
import dashboardHtml from './dashboard.html';
import schemaSql from '../schema.sql';
import { handleApi } from './api';
import { checkPassword, clearCookie, hasSession, loginConfigured, loginPage, sessionCookie, timingSafeEqual } from './auth';
import { MissingKey } from './crypto';
import { checkUpwork, finishUpworkAuth, OAuthError, startUpworkAuth } from './oauth';
import { runWriter } from './pipeline/write';
import { syncDue, syncTrackRecord } from './pipeline/profile';
import { refreshConnects, runSender } from './pipeline/send';
import { sendDue } from './pipeline/pace';
import { addJob } from './pipeline/jobs';
import { sendDailyReport } from './pipeline/report';
import { accountUpkeep } from './pipeline/stats';
import { heldByUpwork } from './upworkPace';
import { checkLoomAlert, cleanupLoomCopies, keepLoomAlive } from './loom';
import { loadSettings, loadState, type Env } from './settings';

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } });

// Columns added after the first deploy: CREATE TABLE IF NOT EXISTS skips existing tables, so add them when missing.
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ['jobs', 'win_score', 'INTEGER'], ['jobs', 'profile_score', 'INTEGER'],
  ['jobs', 'proposals_tier', 'TEXT'], ['jobs', 'analysis', 'TEXT'],
  ['proposals', 'win_score', 'INTEGER'], ['proposals', 'profile_score', 'INTEGER'],
  ['proposals', 'loom_deleted_at', 'TEXT'],
  ['proposals', 'approved_at', 'TEXT'], ['proposals', 'approved_via', 'TEXT'],
  ['proposals', 'boost_connects', 'INTEGER'],
  ['jobs', 'skills', 'TEXT'],
];

// Creates the tables on first use (every statement is CREATE ... IF NOT EXISTS), so a fresh D1 needs no manual step.
let schemaReady: Promise<void> | null = null;
function ensureSchema(env: Env): Promise<void> {
  schemaReady ??= (async () => {
    const statements = schemaSql
      .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
      .split(';').map((s) => s.trim()).filter(Boolean);
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
    for (const table of new Set(ADDED_COLUMNS.map(([t]) => t))) {
      const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
      const have = new Set(results.map((r) => r.name));
      const missing = ADDED_COLUMNS.filter(([t, c]) => t === table && !have.has(c));
      if (missing.length) await env.DB.batch(missing.map(([t, c, type]) => env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`)));
    }
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

// Shown after the Upwork redirect. Success moves on with a same-site navigation, so the SameSite=Strict session cookie is sent.
function resultPage(ok: boolean, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${ok ? '<meta http-equiv="refresh" content="1;url=/#settings">' : ''}<title>Upwork · Upwork Auto-Bidder</title>
<style>:root{--bg:#F3F4F2;--surface:#fff;--fg:#16181D;--muted:#5B615A;--line:#DDE0DB;--accent:#1F5F4F;--bad:#8A2A15;color-scheme:light}
@media (prefers-color-scheme: dark){:root{--bg:#111312;--surface:#1A1D1B;--fg:#E7EAE6;--muted:#A1A8A0;--line:#2C312D;--accent:#5CC4A2;--bad:#F3A693;color-scheme:dark}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif;padding:16px}
main{max-width:420px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:28px;display:flex;flex-direction:column;gap:12px}
h1{margin:0;font-size:20px;color:${ok ? 'var(--accent)' : 'var(--bad)'}} p{margin:0;color:var(--muted)} a{color:var(--accent);font-weight:600}</style></head>
<body><main><h1>${ok ? 'Upwork connected' : 'Upwork not connected'}</h1><p>${escHtml(message)}</p><a href="/#settings">Back to the dashboard</a></main></body></html>`;
}

async function handleUpworkCallback(req: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  try {
    await finishUpworkAuth(env, new URL(req.url).searchParams);
  } catch (e) {
    console.error('upwork callback failed', e instanceof Error ? e.message : e);
    const msg = e instanceof OAuthError || e instanceof MissingKey ? e.message : 'Something went wrong while connecting. Check the Worker logs and try again.';
    return html(resultPage(false, msg), 400);
  }
  // Signed in; reading the account and Connects can fail separately and shows on the dashboard with a "Check now" button.
  const msg = await checkUpwork(env).then((s) => `Bidding as ${s.upwork.account ?? 'the freelancer account'} · returning to the dashboard…`, () => 'Signed in. Some account details could not be read yet; see Settings on the dashboard.');
  return html(resultPage(true, msg));
}

async function handleLogin(req: Request, env: Env, secure: boolean): Promise<Response> {
  if (!loginConfigured(env)) {
    return html(loginPage('Login is not set up yet. Add the DASH_PASSWORD secret in Cloudflare.'), 503);
  }
  if (req.method === 'GET') return html(loginPage());
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const form = await req.formData().catch(() => null);
  const password = String(form?.get('password') ?? '');
  if (!checkPassword(env, password)) {
    // Lengths only, never the values: enough to spot a stray character when reading the Worker logs.
    console.log('login failed', { typedPasswordLength: password.length, expectedPasswordLength: (env.DASH_PASSWORD ?? '').length });
    await new Promise((r) => setTimeout(r, 600));
    return html(loginPage("That password doesn't match."), 401);
  }
  return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': await sessionCookie(env, secure) } });
}

// Jobs from outside the dashboard (Oct 30): POST /api/jobs/intake with `authorization: Bearer <INTAKE_SECRET>` and
// {"jobUrl": "https://www.upwork.com/jobs/~02…", "title"?: "…"}. It never searches Upwork: the job waits as 'matched'
// and the writer reads that one job and drafts the proposal within a minute. Any other field (e.g. a description) is
// ignored; the writer uses the job's own page. Off until the INTAKE_SECRET secret (32+ characters) is set.
async function handleIntake(req: Request, env: Env): Promise<Response> {
  const reply = (data: unknown, status: number) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  const secret = env.INTAKE_SECRET ?? '';
  if (secret.length < 32) return reply({ error: 'Job intake is off. Set the INTAKE_SECRET secret (32+ characters) in Cloudflare.' }, 503);
  if (!timingSafeEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`)) return reply({ error: 'Unauthorized' }, 401);
  if (Number(req.headers.get('content-length') || 0) > 64_000) return reply({ error: 'Request is too large' }, 413);
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ error: 'Expected JSON: {"jobUrl": "https://www.upwork.com/jobs/~02…"}' }, 400);
  await ensureSchema(env);
  const r = await addJob(env, { jobUrl: body.jobUrl, title: body.title });
  return reply(r, r.ok ? 202 : 400);
}

// Must match wrangler.toml [triggers]. Separate runs so each gets its own Workers CPU and subrequest limits.
const SEND_CRON = '* * * * *';
const WRITE_CRON = '1-59 * * * *';
const UPKEEP_CRON = '3,8,13,18,23,28,33,38,43,48,53,58 * * * *';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const secure = url.protocol === 'https:';

    if (url.pathname === '/login') return withHeaders(await handleLogin(req, env, secure));
    // No session check here: the cookie is SameSite=Strict, so it is not sent on the redirect back from Upwork. The single-use
    // OAuth state (created by a signed-in /oauth/upwork/start) is what ties this request to the dashboard.
    if (url.pathname === '/oauth/upwork/callback' && req.method === 'GET') return withHeaders(await handleUpworkCallback(req, env));
    // Its own secret, not the dashboard session: called by other services.
    if (url.pathname === '/api/jobs/intake') return withHeaders(await handleIntake(req, env));
        // ==========================================
       // ==========================================
    // APIFY WEBHOOK RECEIVER
    // ==========================================
    if (url.pathname === '/api/apify-webhook' && req.method === 'POST') {
      try {
        if (req.headers.get('Authorization') !== 'Bearer siv-secret-123') {
          return new Response('Unauthorized', { status: 401 });
        }

        const payload = await req.json();
        const jobs = Array.isArray(payload) ? payload : [payload];

        let addedCount = 0;
        for (const job of jobs) {
          const jobUrl = job.url || job.link || job.jobUrl;
          const jobDesc = job.description || job.jobDescription;
          const jobTitle = job.title || job.jobTitle;

          if (!jobUrl || !jobTitle || !jobDesc) continue; 

          const r = await addJob(env, { jobUrl: jobUrl });
          if (r.ok) addedCount++;
        }

        return new Response(JSON.stringify({ success: true, count: addedCount }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        });

      } catch (error: any) {
        console.error('Apify Webhook Error:', error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
    }
    if (url.pathname === '/logout') {
      return withHeaders(new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': clearCookie(secure) } }));
    }

    if (!(await hasSession(req, env))) {
      if (url.pathname.startsWith('/api/')) {
        return withHeaders(new Response(JSON.stringify({ error: 'Signed out. Reload the page to sign in.' }), { status: 401, headers: { 'content-type': 'application/json' } }));
      }
      return withHeaders(new Response(null, { status: 303, headers: { location: '/login' } }));
    }

    await ensureSchema(env);
    if (url.pathname.startsWith('/api/')) return withHeaders(await handleApi(req, env, url.pathname));
    if (url.pathname === '/oauth/upwork/start' && req.method === 'GET') {
      try {
        return withHeaders(new Response(null, { status: 303, headers: { location: await startUpworkAuth(env, url.origin), 'cache-control': 'no-store' } }));
      } catch (e) {
        console.error('upwork start failed', e instanceof Error ? e.message : e);
        const msg = e instanceof OAuthError || e instanceof MissingKey ? e.message : 'Could not reach Upwork. Try again in a minute.';
        return withHeaders(html(resultPage(false, msg), 502));
      }
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return withHeaders(html(dashboardHtml));
    return withHeaders(new Response('Not found', { status: 404 }));
  },
  // Pipeline: job added by link → read and filter → score → letter → preview (M4) → Loom copy (M5) → submit (M6) →
  // report (M7). No Upwork search (Oct 30).
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await ensureSchema(env);
    const log = (what: string) => (e: unknown) => console.error(`${what} failed`, e instanceof Error ? e.message : e);
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (event.cron === SEND_CRON) {
      // Sending only: the job scan was removed (Oct 30, Upwork restricted search on Rafa's account).
      if (!sendDue(minute, (await loadState(env)).mode)) return;
      await runSender(env).catch(log('sender'));
    } else if (event.cron === WRITE_CRON) {
      // Every minute: drafts jobs added by link; with none waiting it makes no Upwork call.
      await runWriter(env).catch(log('writer'));
    } else if (event.cron === UPKEEP_CRON) {
      await refreshConnects(env).catch(log('connects refresh'));
      // Rafa's track record (scoring input), every other day; the writer reads the stored copy.
      const st = await loadState(env);
      if (st.upwork.connected && !heldByUpwork(st) && syncDue(st.trackRecordSyncedAt)) await syncTrackRecord(env).catch(log('track record sync'));
      const s = await loadSettings(env);
      await cleanupLoomCopies(env, s.loom.deleteAfterDays).catch(log('loom cleanup'));
      await keepLoomAlive(env, s.loom.sourceUrl).catch(log('loom keep-alive'));
      await checkLoomAlert(env).catch(log('loom alert'));
      await sendDailyReport(env).catch(log('daily report'));
      // Rafa's account: twice a day, and the Connects history's first read, at Upwork's slow pace (last: it may wait).
      await accountUpkeep(env, s.caps.timezone).catch(log('account upkeep'));
    }
  },
};
