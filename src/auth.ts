import type { Env } from './settings';

const COOKIE = 'ab_session';
const SESSION_DAYS = 30;
const enc = new TextEncoder();

export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

// Sessions are signed with a key derived from the password, so changing DASH_PASSWORD signs everyone out.
async function sign(env: Env, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(`${env.TOKEN_KEY ?? ''}|${env.DASH_USER}|${env.DASH_PASSWORD}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export const loginConfigured = (env: Env) => Boolean(env.DASH_USER?.trim() && env.DASH_PASSWORD);

export async function hasSession(req: Request, env: Env): Promise<boolean> {
  if (!loginConfigured(env)) return false;
  const raw = readCookie(req, COOKIE);
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return timingSafeEqual(sig, await sign(env, exp));
}

export type LoginCheck = 'ok' | 'user' | 'password';

// User name: case and surrounding spaces ignored. Password: exact, except stray spaces around the stored secret.
export function checkCredentials(env: Env, user: string, password: string): LoginCheck {
  const userOk = timingSafeEqual(user.trim().toLowerCase(), (env.DASH_USER ?? '').trim().toLowerCase());
  const passOk = timingSafeEqual(password, env.DASH_PASSWORD ?? '') || timingSafeEqual(password, (env.DASH_PASSWORD ?? '').trim());
  if (!userOk) return 'user';
  return passOk ? 'ok' : 'password';
}

export async function sessionCookie(env: Env, secure: boolean): Promise<string> {
  const exp = String(Date.now() + SESSION_DAYS * 86400_000);
  return `${COOKIE}=${exp}.${await sign(env, exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

export const clearCookie = (secure: boolean) =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export function loginPage(message = '', user = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Upwork Auto-Bidder</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{--bg:#F3F4F2;--surface:#fff;--fg:#16181D;--muted:#5B615A;--line:#DDE0DB;--accent:#1F5F4F;--accent-fg:#fff;--bad-bg:#FBE9E4;--bad-fg:#8A2A15;color-scheme:light}
@media (prefers-color-scheme: dark){:root{--bg:#111312;--surface:#1A1D1B;--fg:#E7EAE6;--muted:#A1A8A0;--line:#2C312D;--accent:#5CC4A2;--accent-fg:#0C1A15;--bad-bg:#3A1B14;--bad-fg:#F3A693;color-scheme:dark}}
*{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font-family:"IBM Plex Sans",system-ui,sans-serif;padding:16px}
form{width:100%;max-width:380px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:28px;display:flex;flex-direction:column;gap:16px}
h1{margin:0;font-size:20px} p{margin:0;color:var(--muted);font-size:14px}
label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:500}
input{font:inherit;color:inherit;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:11px 12px;min-height:44px}
button{font:inherit;font-weight:600;background:var(--accent);color:var(--accent-fg);border:0;border-radius:8px;min-height:46px;cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.err{background:var(--bad-bg);color:var(--bad-fg);border-radius:8px;padding:10px 12px;font-size:14px}
</style></head><body>
<form method="post" action="/login">
  <div><h1>Upwork Auto-Bidder</h1><p>Sign in to the dashboard.</p></div>
  ${message ? `<div class="err" role="alert">${esc(message)}</div>` : ''}
  <label for="user">User name<input id="user" name="user" autocomplete="username" autocapitalize="off" spellcheck="false" required value="${esc(user)}"></label>
  <label for="password">Password<input id="password" name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
</form>
</body></html>`;
}
