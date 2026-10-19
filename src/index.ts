import dashboardHtml from './dashboard.html';
import schemaSql from '../schema.sql';
import { handleApi } from './api';
import { checkCredentials, clearCookie, hasSession, loginConfigured, loginPage, sessionCookie } from './auth';
import type { Env } from './settings';

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

// Creates the tables on first use (every statement is CREATE ... IF NOT EXISTS), so a fresh D1 needs no manual step.
let schemaReady: Promise<void> | null = null;
function ensureSchema(env: Env): Promise<void> {
  schemaReady ??= (async () => {
    const statements = schemaSql
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
      .split(';').map((s) => s.trim()).filter(Boolean);
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

async function handleLogin(req: Request, env: Env, secure: boolean): Promise<Response> {
  if (!loginConfigured(env)) {
    return html(loginPage('Login is not set up yet. Add the DASH_USER and DASH_PASSWORD secrets in Cloudflare.'), 503);
  }
  if (req.method === 'GET') return html(loginPage());
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const form = await req.formData().catch(() => null);
  const user = String(form?.get('user') ?? '');
  const password = String(form?.get('password') ?? '');
  const result = checkCredentials(env, user, password);
  if (result !== 'ok') {
    // Lengths only, never the values: enough to spot a stray character when reading the Worker logs.
    console.log('login failed', { reason: result, typedUserLength: user.length, typedPasswordLength: password.length, expectedPasswordLength: (env.DASH_PASSWORD ?? '').length });
    await new Promise((r) => setTimeout(r, 600));
    const msg = result === 'user' ? "That user name doesn't match." : "That password doesn't match.";
    return html(loginPage(msg, user), 401);
  }
  return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': await sessionCookie(env, secure) } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const secure = url.protocol === 'https:';

    if (url.pathname === '/login') return withHeaders(await handleLogin(req, env, secure));
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
    if (url.pathname === '/' || url.pathname === '/index.html') return withHeaders(html(dashboardHtml));
    return withHeaders(new Response('Not found', { status: 404 }));
  },

  // The bidding pipeline (scan → filter → score → letter → Loom copy → preview → submit) plugs in here next.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await ensureSchema(env);
  },
};
