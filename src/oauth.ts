import { randomToken, seal, sha256b64url, unseal } from './crypto';
import { McpAuthError, McpClient } from './mcp';
import { loadState, patchState, type Env, type State } from './settings';

// Upwork sign-in: OAuth 2.1 with dynamic client registration and PKCE, as advertised by the MCP server.

const STATE_TTL_MS = 10 * 60_000;

// Upwork only registers redirect URIs on localhost or a few AI platforms, so the deployed Worker can't be a redirect target.
// Instead Upwork sends the browser to this unused local address; the page fails to load, and the person pastes the address
// (which carries the one-time code and state) into the dashboard. PKCE keeps that code useless without our verifier.
export const PASTE_REDIRECT_URI = 'http://127.0.0.1:53682/upwork-callback';

export function redirectUriFor(origin: string): string {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? `${origin}/oauth/upwork/callback` : PASTE_REDIRECT_URI;
}

// Accepts the full address from the browser bar (or just its query string) and returns its parameters.
export function paramsFromPasted(text: string): URLSearchParams {
  const t = text.trim();
  if (!t || t.length > 4000) throw new OAuthError('Paste the full address from the browser bar after clicking Allow on Upwork.');
  const query = t.includes('?') ? t.slice(t.indexOf('?') + 1) : t;
  const params = new URLSearchParams(query.split('#')[0]);
  if (!params.get('error') && (!params.get('code') || !params.get('state'))) {
    throw new OAuthError('That address has no sign-in code. Copy the whole address (it contains "code=") after clicking Allow on Upwork.');
  }
  return params;
}
const REFRESH_EARLY_MS = 2 * 60_000;

interface AuthServer {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
}

interface Client { redirectUri: string; clientId: string; clientSecret?: string; authMethod: string }

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // ms epoch
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  clientId: string;
  clientSecret?: string;
  authMethod: string;
}

export class OAuthError extends Error {}

async function getKv(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}
async function putKv(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(key, value).run();
}
const delKv = (env: Env, key: string) => env.DB.prepare('DELETE FROM kv WHERE key = ?').bind(key).run();

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

// Protected-resource metadata (from WWW-Authenticate, else the well-known paths), then the authorization server metadata.
async function discover(env: Env): Promise<AuthServer> {
  const mcp = new URL(env.UPWORK_MCP_URL);
  const probe = await fetch(mcp, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}', signal: AbortSignal.timeout(15_000) });
  await probe.body?.cancel();
  const hinted = /resource_metadata="([^"]+)"/.exec(probe.headers.get('www-authenticate') ?? '')?.[1];
  const candidates = [hinted, `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname}`, `${mcp.origin}/.well-known/oauth-protected-resource`]
    .filter((u): u is string => Boolean(u && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(u)));
  let prm: Record<string, unknown> | null = null;
  for (const u of candidates) if ((prm = await getJson(u))) break;
  const issuer = (prm?.authorization_servers as string[] | undefined)?.[0] ?? mcp.origin;
  const iss = new URL(issuer);
  const suffix = iss.pathname === '/' ? '' : iss.pathname;
  const meta = (await getJson(`${iss.origin}/.well-known/oauth-authorization-server${suffix}`))
    ?? (await getJson(`${iss.origin}/.well-known/openid-configuration${suffix}`));
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw new OAuthError('Could not find Upwork sign-in details. Try again in a minute.');
  return meta as unknown as AuthServer;
}

async function getClient(env: Env, as: AuthServer, redirectUri: string): Promise<Client> {
  const stored = await getKv(env, 'upwork_client');
  const existing = stored ? await unseal<Client>(env, stored) : null;
  if (existing && existing.redirectUri === redirectUri) return existing;
  if (!as.registration_endpoint) throw new OAuthError('Upwork does not offer client registration.');
  const res = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Upwork Auto-Bidder (LTV Labs)',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || !body.client_id) throw new OAuthError(`Upwork client registration failed: ${body.error_description || body.error || res.status}`);
  const client: Client = {
    redirectUri,
    clientId: body.client_id,
    clientSecret: body.client_secret || undefined,
    authMethod: body.token_endpoint_auth_method || (body.client_secret ? 'client_secret_post' : 'none'),
  };
  await putKv(env, 'upwork_client', await seal(env, client));
  return client;
}

export async function startUpworkAuth(env: Env, origin: string): Promise<string> {
  const as = await discover(env);
  const redirectUri = redirectUriFor(origin);
  const client = await getClient(env, as, redirectUri);
  const verifier = randomToken(48);
  const state = randomToken(24);
  await env.DB.prepare("DELETE FROM kv WHERE key LIKE 'oauth_state:%' AND updated_at < datetime('now', '-1 day')").run();
  await putKv(env, `oauth_state:${state}`, await seal(env, { verifier, redirectUri, exp: Date.now() + STATE_TTL_MS, as }));
  const url = new URL(as.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: redirectUri,
    code_challenge: await sha256b64url(verifier),
    code_challenge_method: 'S256',
    state,
    resource: env.UPWORK_MCP_URL,
  }).toString();
  return url.toString();
}

async function tokenRequest(t: Pick<Tokens, 'tokenEndpoint' | 'clientId' | 'clientSecret' | 'authMethod'>, form: Record<string, string>) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const body = new URLSearchParams({ ...form, client_id: t.clientId });
  if (t.clientSecret && t.authMethod === 'client_secret_basic') headers.authorization = `Basic ${btoa(`${t.clientId}:${t.clientSecret}`)}`;
  else if (t.clientSecret) body.set('client_secret', t.clientSecret);
  const res = await fetch(t.tokenEndpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
  const data = (await res.json().catch(() => ({}))) as Record<string, string | number>;
  return { ok: res.ok && typeof data.access_token === 'string', status: res.status, data };
}

async function saveTokens(env: Env, base: Omit<Tokens, 'accessToken' | 'refreshToken' | 'expiresAt'>, data: Record<string, string | number>, previousRefresh: string | null) {
  const tokens: Tokens = {
    ...base,
    accessToken: String(data.access_token),
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : previousRefresh,
    expiresAt: Date.now() + (Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600) * 1000,
  };
  await putKv(env, 'upwork_tokens', await seal(env, tokens));
  return tokens;
}

export async function finishUpworkAuth(env: Env, params: URLSearchParams): Promise<void> {
  if (params.get('error')) {
    throw new OAuthError(params.get('error') === 'access_denied' ? 'Upwork sign-in was cancelled.' : `Upwork sign-in failed: ${params.get('error_description') || params.get('error')}`);
  }
  const state = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(state) || !code) throw new OAuthError('This sign-in link is incomplete. Start again from the dashboard.');
  const stored = await getKv(env, `oauth_state:${state}`);
  await delKv(env, `oauth_state:${state}`); // single use
  const s = stored ? await unseal<{ verifier: string; redirectUri: string; exp: number; as: AuthServer }>(env, stored) : null;
  if (!s || s.exp < Date.now()) throw new OAuthError('This sign-in link expired. Start again from the dashboard.');

  const clientRaw = await getKv(env, 'upwork_client');
  const client = clientRaw ? await unseal<Client>(env, clientRaw) : null;
  if (!client) throw new OAuthError('Upwork client registration is missing. Start again from the dashboard.');
  const base = {
    tokenEndpoint: s.as.token_endpoint,
    revocationEndpoint: s.as.revocation_endpoint ?? null,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    authMethod: client.authMethod,
  };
  const r = await tokenRequest(base, { grant_type: 'authorization_code', code, redirect_uri: s.redirectUri, code_verifier: s.verifier, resource: env.UPWORK_MCP_URL });
  if (!r.ok) throw new OAuthError(`Upwork did not accept the sign-in (${r.data.error_description || r.data.error || r.status}).`);
  await saveTokens(env, base, r.data, null);
  const st = await loadState(env);
  await patchState(env, { upwork: { ...st.upwork, connected: true, lastError: null } });
}

async function markDisconnected(env: Env, reason: string): Promise<void> {
  await delKv(env, 'upwork_tokens');
  const st = await loadState(env);
  await patchState(env, { upwork: { ...st.upwork, connected: false, lastError: reason } });
}

async function loadTokens(env: Env): Promise<Tokens | null> {
  const raw = await getKv(env, 'upwork_tokens');
  return raw ? unseal<Tokens>(env, raw) : null;
}

// A valid access token, refreshed shortly before expiry. On invalid_grant the connection is marked for reconnecting.
export async function getAccessToken(env: Env): Promise<string> {
  const t = await loadTokens(env);
  if (!t) throw new OAuthError('Upwork is not connected.');
  if (t.expiresAt - REFRESH_EARLY_MS > Date.now()) return t.accessToken;
  if (!t.refreshToken) {
    await markDisconnected(env, 'Upwork sign-in expired. Reconnect Upwork.');
    throw new OAuthError('Upwork sign-in expired.');
  }
  const r = await tokenRequest(t, { grant_type: 'refresh_token', refresh_token: t.refreshToken, resource: env.UPWORK_MCP_URL });
  if (r.ok) return (await saveTokens(env, t, r.data, t.refreshToken)).accessToken;
  if (r.data.error === 'invalid_grant') {
    // Another run may have just rotated the refresh token; use its result if so.
    const latest = await loadTokens(env);
    if (latest && latest.refreshToken !== t.refreshToken && latest.expiresAt - REFRESH_EARLY_MS > Date.now()) return latest.accessToken;
    await markDisconnected(env, 'Upwork sign-in expired. Reconnect Upwork.');
    throw new OAuthError('Upwork sign-in expired.');
  }
  throw new OAuthError(`Could not refresh the Upwork sign-in (${r.data.error_description || r.data.error || r.status}).`);
}

export async function upworkClient(env: Env): Promise<McpClient> {
  const client = new McpClient(env.UPWORK_MCP_URL, await getAccessToken(env));
  try {
    await client.initialize();
  } catch (e) {
    if (!(e instanceof McpAuthError)) throw e;
    const reason = 'Upwork refused the saved sign-in. Reconnect Upwork.';
    await markDisconnected(env, reason);
    throw new OAuthError(reason);
  }
  return client;
}

const NEEDED_TOOLS = ['list_accounts', 'get_freelancer_dashboard', 'find_jobs', 'list_freelancer_proposals', 'manage_proposals', 'confirm_preview', 'get_tool_help'] as const;

// Upstream names may carry a prefix such as "upwork__"; map each base name to the real one.
export function resolveToolNames(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const base of NEEDED_TOOLS) {
    const hit = names.find((n) => n === base) ?? names.find((n) => n.endsWith(`__${base}`) || n.endsWith(`.${base}`));
    if (hit) out[base] = hit;
  }
  return out;
}

// Depth-limited search for the first value under a key, for response shapes that nest differently.
export function findKey(obj: unknown, key: string, depth = 6): unknown {
  if (depth < 0 || typeof obj !== 'object' || obj === null) return undefined;
  if (!Array.isArray(obj) && key in obj) return (obj as Record<string, unknown>)[key];
  for (const v of Object.values(obj)) {
    const hit = findKey(v, key, depth - 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

interface Account { name?: string; org_uid?: string; role?: string }

// After connecting (and on "Check now"): resolve tool names, pick Rafa's TALENT account, read the Connects balance.
export async function checkUpwork(env: Env): Promise<State> {
  const st = await loadState(env);
  try {
    const client = await upworkClient(env);
    const names = await client.listTools();
    console.log('upwork tools', names);
    const toolNames = resolveToolNames(names);
    if (!toolNames.list_accounts || !toolNames.find_jobs) {
      throw new OAuthError(`Upwork shows its tools in search mode. Switch the Upwork MCP tool mode to "full list", then press Check now. (Tools seen: ${names.slice(0, 8).join(', ') || 'none'})`);
    }
    const raw = await client.callTool(toolNames.list_accounts, {});
    const accounts = (findKey(raw, 'accounts') ?? []) as Account[];
    // Shape only (keys and roles), to diagnose an unexpected response without logging account details.
    console.log('upwork list_accounts shape', typeof raw, raw && typeof raw === 'object' ? Object.keys(raw) : '', Array.isArray(accounts) ? accounts.map((a) => a.role) : typeof accounts);
    const talent = Array.isArray(accounts) ? accounts.find((a) => a.role === 'TALENT' && a.org_uid) : undefined;
    if (!talent?.org_uid) throw new OAuthError('This Upwork login has no freelancer (TALENT) account. Sign in with Rafa\'s freelancer account.');
    let connectsBalance = st.connectsBalance;
    if (toolNames.get_freelancer_dashboard) {
      const dash = await client.callTool(toolNames.get_freelancer_dashboard, { action: 'check', org_uid: talent.org_uid });
      const bal = Number(findKey(dash, 'connectsBalance'));
      if (Number.isFinite(bal)) connectsBalance = bal;
    }
    return await patchState(env, {
      connectsBalance,
      upwork: { connected: true, account: talent.name ?? null, orgUid: talent.org_uid, toolNames, lastError: null, checkedAt: new Date().toISOString() },
    });
  } catch (e) {
    const fresh = await loadState(env);
    const msg = e instanceof Error ? e.message : String(e);
    await patchState(env, { upwork: { ...fresh.upwork, lastError: msg, checkedAt: new Date().toISOString() } });
    throw e;
  }
}

export async function disconnectUpwork(env: Env): Promise<State> {
  const t = await loadTokens(env).catch(() => null);
  if (t?.revocationEndpoint && t.refreshToken) {
    await tokenRequest({ ...t, tokenEndpoint: t.revocationEndpoint }, { token: t.refreshToken, token_type_hint: 'refresh_token' }).catch(() => null);
  }
  await delKv(env, 'upwork_tokens');
  return patchState(env, { upwork: { connected: false, account: null, orgUid: null, toolNames: {}, lastError: null, checkedAt: null } });
}
