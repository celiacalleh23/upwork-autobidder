import dashboardHtml from './dashboard.html';
import schemaSql from '../schema.sql';
import { handleApi } from './api';
import { checkPassword, clearCookie, hasSession, loginConfigured, loginPage, sessionCookie } from './auth';
import { MissingKey } from './crypto';
import { checkUpwork, finishUpworkAuth, OAuthError, startUpworkAuth } from './oauth';
import { runScan } from './pipeline/scan';
import { runWriter } from './pipeline/write';
import { refreshConnects, runSender } from './pipeline/send';
import { checkLoomAlert, cleanupLoomCopies, keepLoomAlive } from './loom';
import { loadSettings, type Env } from './settings';

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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const secure = url.protocol === 'https:';

    if (url.pathname === '/login') return withHeaders(await handleLogin(req, env, secure));
    // No session check here: the cookie is SameSite=Strict, so it is not sent on the redirect back from Upwork. The single-use
    // OAuth state (created by a signed-in /oauth/upwork/start) is what ties this request to the dashboard.
    if (url.pathname === '/oauth/upwork/callback' && req.method === 'GET') return withHeaders(await handleUpworkCallback(req, env));
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

  // Pipeline: scan → filter (M3) → score → letter → preview (M4) → Loom copy (M5) → submit (M6). Reports (M7) next.
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await ensureSchema(env);
    if (event.cron !== '*/5 * * * *') return;
    // The sender goes first: if a run is cut short (Workers CPU or time limits), sending approved proposals must not
    // depend on the scan finishing. The writer follows each scan, so its numbers land on that scan's run row.
    await runSender(env).catch((e) => console.error('sender failed', e instanceof Error ? e.message : e));
    if (await runScan(env)) await runWriter(env);
    await refreshConnects(env).catch((e) => console.error('connects refresh failed', e instanceof Error ? e.message : e));
    const s = await loadSettings(env);
    await cleanupLoomCopies(env, s.loom.deleteAfterDays).catch((e) => console.error('loom cleanup failed', e instanceof Error ? e.message : e));
    await keepLoomAlive(env, s.loom.sourceUrl).catch((e) => console.error('loom keep-alive failed', e instanceof Error ? e.message : e));
    await checkLoomAlert(env).catch((e) => console.error('loom alert failed', e instanceof Error ? e.message : e));
  },
};
