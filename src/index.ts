import dashboardHtml from './dashboard.html';
import { handleApi } from './api';
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

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function authorized(req: Request, env: Env): Response | null {
  if (!env.DASH_USER || !env.DASH_PASSWORD) {
    return new Response('Dashboard login is not configured. Set DASH_USER and DASH_PASSWORD.', { status: 503 });
  }
  const header = req.headers.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = atob(header.slice(6)); } catch { /* bad header */ }
    const i = decoded.indexOf(':');
    if (i > 0 && timingSafeEqual(decoded.slice(0, i), env.DASH_USER) && timingSafeEqual(decoded.slice(i + 1), env.DASH_PASSWORD)) return null;
  }
  return new Response('Sign in to the Auto-Bidder dashboard.', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="Upwork Auto-Bidder", charset="UTF-8"' },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const denied = authorized(req, env);
    if (denied) return withHeaders(denied);

    if (url.pathname.startsWith('/api/')) return withHeaders(await handleApi(req, env, url.pathname));
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return withHeaders(new Response(dashboardHtml, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }));
    }
    return withHeaders(new Response('Not found', { status: 404 }));
  },

  // The bidding pipeline (scan → filter → score → letter → Loom copy → preview → submit) plugs in here next.
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {},
};
