import { seal, unseal } from './crypto';
import { refusePreview } from './previewIsolation';
import { emailConfigured, sendEmail } from './email';
import { acquireLease, delKv, getKv, putKv, releaseLease } from './kv';
import { loadSettings, loadState, patchState, reportEmails, type Env, type State } from './settings';

// Loom copies (M5). Loom has no public API: these are the requests loom.com itself sends, captured by Celia on Oct 22
// (docs/loom-api.md). The session is the browser cookie pasted in Settings → Loom; it is stored encrypted and never logged.

const ENDPOINT = 'https://www.loom.com/graphql';
const SESSION_KEY = 'loom:session';
const TIMEOUT_MS = 20_000;

export class LoomError extends Error {}
export class LoomAuthError extends LoomError {}

export const videoIdFrom = (url: string): string | null => /loom\.com\/share\/([A-Za-z0-9]+)/.exec(url)?.[1] ?? null;
export const shareUrl = (id: string) => `https://www.loom.com/share/${id}`;

// Accepts the connect.sid value on its own, "connect.sid=…", or a whole Cookie line copied from DevTools.
export function cookieFrom(pasted: string): string | null {
  const v = pasted.trim().replace(/^cookie:\s*/i, '');
  if (!v || v.length > 8000 || /[\r\n]/.test(v)) return null;
  return v.includes('=') ? v : `connect.sid=${v}`;
}

// Loom names copies with the job title; keep it plain text and within a sane length.
export const copyName = (title: string) => title.replace(/\s+/g, ' ').trim().slice(0, 250) || 'Proposal video';

const AUTH_HINT = /unauth|not authori[sz]ed|log ?in|sign ?in|session|forbidden/i;

// The stored session. Loom renews connect.sid in its answers (Set-Cookie); gql picks that up so the stored copy
// never runs out while the tool keeps using it (Celia, Oct 22: the cookie she pasted expires in Nov 2026).
export interface Session { cookie: string; expiresAt: string | null; renewed?: boolean }

// Fold every Set-Cookie Loom sends into the stored jar. A cleared cookie (empty value or Max-Age=0) is a sign-out
// and is ignored. connect.sid is the session; other names are kept too, in case the session needs them.
export function applySetCookies(cookie: string, setCookies: string[], now = Date.now()): { cookie: string; expiresAt: string | null; changed: boolean } {
  let next = cookie;
  let expiresAt: string | null = null;
  let changed = false;
  for (const line of setCookies) {
    const m = /^\s*([A-Za-z0-9_.-]+)=([^;]*)/.exec(line);
    if (!m) continue;
    const name = m[1];
    const value = m[2];
    const maxAge = /;\s*max-age=(\d+)/i.exec(line);
    if (!value || (maxAge && Number(maxAge[1]) === 0)) continue;
    const re = new RegExp(`(^|;\\s*)${name}=[^;]*`);
    next = re.test(next) ? next.replace(re, `$1${name}=${value}`) : (next ? `${next}; ${name}=${value}` : `${name}=${value}`);
    changed = true;
    if (name === 'connect.sid') {
      const expires = /;\s*expires=([^;]+)/i.exec(line);
      const at = maxAge ? now + Number(maxAge[1]) * 1000 : expires ? Date.parse(expires[1]) : NaN;
      if (Number.isFinite(at)) expiresAt = new Date(at).toISOString();
    }
  }
  return { cookie: next, expiresAt, changed };
}

// Reads a renewed connect.sid (and its expiry) from Set-Cookie lines. Null when Loom did not send one.
export function renewedCookie(cookie: string, setCookies: string[], now = Date.now()): { cookie: string; expiresAt: string | null } | null {
  const applied = applySetCookies(cookie, setCookies, now);
  return applied.changed ? { cookie: applied.cookie, expiresAt: applied.expiresAt } : null;
}

function hasAuthType(value: unknown): boolean {
  const stack = [value];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    const type = (cur as { __typename?: unknown }).__typename;
    if (typeof type === 'string' && /NotAuthori[sz]ed|Unauthenticated/i.test(type)) return true;
    for (const child of Object.values(cur)) if (child && typeof child === 'object') stack.push(child);
  }
  return false;
}

const setCookieLines = (h: Headers): string[] => {
  const all = (h as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (all) return all;
  const one = h.get('set-cookie');
  return one ? one.split(/,(?=\s*[A-Za-z0-9_.-]+=)/) : [];
};

async function gql<T>(sess: Session, operationName: string, query: string, variables: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie: sess.cookie,
        origin: 'https://www.loom.com',
        referer: 'https://www.loom.com/looms/videos',
        'apollographql-client-name': 'web',
        'x-loom-request-source': 'loom_web',
      },
      body: JSON.stringify({ operationName, variables, query }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new LoomError(`Loom ${operationName}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403) throw new LoomAuthError(`Loom refused the session (${res.status}). Paste a fresh one in Settings → Loom.`);
  if (!res.ok) throw new LoomError(`Loom ${operationName} failed (${res.status})`);
  if (!(res.headers.get('content-type') ?? '').includes('json')) {
    throw new LoomAuthError('Loom answered with a web page instead of data; the session has probably expired. Paste a fresh one in Settings → Loom.');
  }
  const body = await res.json().catch(() => null) as { data?: T; errors?: { message?: string }[] } | null;
  if (body?.errors?.length) {
    const msg = body.errors.map((e) => e.message ?? '').join('; ').slice(0, 200);
    throw AUTH_HINT.test(msg) ? new LoomAuthError(`Loom: ${msg}`) : new LoomError(`Loom ${operationName}: ${msg}`);
  }
  if (!body?.data) throw new LoomError(`Loom ${operationName}: empty answer`);
  if (hasAuthType(body.data)) {
    // Do not store Set-Cookie from a refused call. That header can replace a good session with a logged-out one.
    throw new LoomAuthError('Loom did not accept the session. Paste a fresh one in Settings → Loom.');
  }
  const renewed = applySetCookies(sess.cookie, setCookieLines(res.headers));
  if (renewed.changed && (renewed.cookie !== sess.cookie || (renewed.expiresAt && renewed.expiresAt !== sess.expiresAt))) {
    Object.assign(sess, { cookie: renewed.cookie, expiresAt: renewed.expiresAt ?? sess.expiresAt, renewed: true });
  }
  return body.data;
}

const DUPLICATE = `mutation DuplicateVideo($videoId: ID!, $newName: String!, $spaceId: ID, $password: String) {
  duplicateVideo(videoId: $videoId, newName: $newName, spaceId: $spaceId, password: $password) {
    __typename
    ... on GenericError { __typename message }
    ... on DuplicateVideoPayload { __typename newVideo { __typename id name } }
  }
}`;

const BULK_DELETE = `mutation BulkDeleteVideos($videoIds: [ID]!) {
  bulkDeleteVideos(videoIds: $videoIds) {
    ... on BulkDeleteVideosPayload { success __typename }
    __typename
  }
}`;

// Loom answers failures as typed results, e.g. { __typename: 'UserNotAuthorizedError' } for a bad session (seen Oct 22).
function throwIfError(r: { __typename?: string; message?: string } | null | undefined, what: string) {
  const type = r?.__typename ?? '';
  if (!type.endsWith('Error')) return;
  const msg = (r?.message ?? type).slice(0, 200);
  if (/NotAuthori[sz]ed|Unauth|Login/i.test(type) || AUTH_HINT.test(msg)) {
    throw new LoomAuthError(`Loom did not accept the session (${msg}). Paste a fresh one in Settings → Loom.`);
  }
  throw new LoomError(`Loom could not ${what}: ${msg}`);
}

interface DuplicateData { duplicateVideo?: { __typename?: string; message?: string; newVideo?: { id?: string; name?: string } } }
export function readDuplicate(data: DuplicateData): { id: string; name: string } {
  const r = data.duplicateVideo;
  throwIfError(r, 'copy the video');
  const id = r?.newVideo?.id;
  if (!id || !/^[A-Za-z0-9]+$/.test(id)) throw new LoomError('Loom did not return the new video id');
  return { id, name: r?.newVideo?.name ?? '' };
}

export async function duplicate(sess: Session, videoId: string, newName: string) {
  return readDuplicate(await gql<DuplicateData>(sess, 'DuplicateVideo', DUPLICATE, { videoId, newName, spaceId: null, password: null }));
}

export async function deleteVideos(sess: Session, ids: string[]): Promise<boolean> {
  const data = await gql<{ bulkDeleteVideos?: { __typename?: string; message?: string; success?: boolean } }>(sess, 'BulkDeleteVideos', BULK_DELETE, { videoIds: ids });
  throwIfError(data.bulkDeleteVideos, 'delete the video');
  return data.bulkDeleteVideos?.success === true;
}

// ---------- Session storage ----------

const ACTIVE_KEY = 'loom:activeAt';

async function loadSession(env: Env): Promise<Session | null> {
  const sealed = await getKv(env, SESSION_KEY);
  const v = sealed ? await unseal<{ cookie: string; expiresAt?: string | null }>(env, sealed) : null;
  return v?.cookie ? { cookie: v.cookie, expiresAt: v.expiresAt ?? null } : null;
}

async function saveSession(env: Env, sess: Session) {
  await putKv(env, SESSION_KEY, await seal(env, { cookie: sess.cookie, expiresAt: sess.expiresAt }));
}

export async function markLoomError(env: Env, e: unknown) {
  const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  const st = await loadState(env);
  await patchState(env, { loom: { ...(e instanceof LoomAuthError ? { connected: false } : {}), lastError: msg } });
}

// Runs Loom calls with the stored session: saves a renewed cookie, notes the activity, and marks the connection
// lost on an auth error. Null when Loom is not connected.
async function withSession<T>(env: Env, fn: (sess: Session) => Promise<T>): Promise<T | null> {
  refusePreview(env);
  // One Loom call at a time. A second call with the old cookie can overwrite a cookie Loom just rotated.
  const lease = await acquireLease(env, 'loom-session', 60_000);
  if (!lease) throw new LoomError('Loom is busy; it will be tried again shortly.');
  try {
    let sess = await loadSession(env);
    if (!sess) {
      if (!(await loadState(env)).loom.connected) return null;
      const e = new LoomAuthError('The saved Loom session could not be read. Press Reconnect in Settings → Loom video.');
      await markLoomError(env, e);
      throw e;
    }
    const started = sess.cookie;
    try {
      const out = await fn(sess);
      await putKv(env, ACTIVE_KEY, String(Date.now()));
      return out;
    } catch (e) {
      if (!(e instanceof LoomAuthError)) throw e;
      const latest = await loadSession(env);
      if (latest && latest.cookie !== started) {
        sess = latest;
        const out = await fn(sess);
        await putKv(env, ACTIVE_KEY, String(Date.now()));
        return out;
      }
      await markLoomError(env, e);
      throw e;
    } finally {
      if (sess.renewed) {
        await saveSession(env, sess);
        await patchState(env, { loom: { expiresAt: sess.expiresAt, renewedAt: new Date().toISOString() } });
      }
    }
  } finally {
    await releaseLease(env, 'loom-session', lease);
  }
}

// The Expires date typed from DevTools (YYYY-MM-DD), used until Loom sends its own. Must be in the next two years.
export function expiryHint(v: unknown, now = Date.now()): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  const at = Date.parse(`${v.trim()}T00:00:00Z`);
  return Number.isFinite(at) && at > now && at < now + 2 * 365 * 86_400_000 ? new Date(at).toISOString() : null;
}

// Proves the session can copy the source video: makes one copy and deletes it straight away.
export async function connectLoom(env: Env, pasted: string, sourceUrl: string, expires: unknown = null): Promise<State> {
  refusePreview(env);
  const cookie = cookieFrom(pasted);
  if (!cookie) throw new LoomError('Paste the connect.sid value from loom.com (one line).');
  const source = videoIdFrom(sourceUrl);
  if (!source) throw new LoomError('Save the source video link in Settings → Loom first.');
  const sess: Session = { cookie, expiresAt: expiryHint(expires) };
  const copy = await duplicate(sess, source, 'Connection test (Upwork Auto-Bidder) - safe to delete');
  await deleteVideos(sess, [copy.id]).catch((e) => console.error('loom: test copy not deleted', e instanceof Error ? e.message : e));
  await saveSession(env, sess);
  await putKv(env, ACTIVE_KEY, String(Date.now()));
  const nowIso = new Date().toISOString();
  return patchState(env, { loom: { connected: true, lastError: null, checkedAt: nowIso, expiresAt: sess.expiresAt, renewedAt: sess.renewed ? nowIso : null } });
}

export async function disconnectLoom(env: Env): Promise<State> {
  await delKv(env, SESSION_KEY);
  return patchState(env, { loom: { connected: false, lastError: null, checkedAt: null, expiresAt: null } });
}

// A copy of the source video named after the job, for one proposal. Null when Loom is not connected.
export async function copyForJob(env: Env, sourceUrl: string, title: string): Promise<{ id: string; url: string } | null> {
  const source = videoIdFrom(sourceUrl);
  if (!source) return null;
  const copy = await withSession(env, (sess) => duplicate(sess, source, copyName(title)));
  if (!copy) return null;
  try { await putKv(env, `loom:copy:${copy.id}`, JSON.stringify({ id: copy.id, createdAt: new Date().toISOString() })); }
  catch (e) { await withSession(env, sess => deleteVideos(sess, [copy.id])).catch(() => undefined); throw e; }
  return { id: copy.id, url: shareUrl(copy.id) };
}

export async function deleteCopy(env: Env, id: string): Promise<void> {
  if (await withSession(env, (sess) => deleteVideos(sess, [id]))) await delKv(env, `loom:copy:${id}`);
}

// ---------- Upkeep (from the 5-minute cron) ----------

const CLEANUP_KEY = 'loom:cleanupAt';
const CLEANUP_EVERY_MS = 6 * 3600_000;
const CLEANUP_BATCH = 20;
const KEEP_ALIVE_MS = 12 * 3600_000;

// Copies older than settings.loom.deleteAfterDays are deleted, only ids this tool created.
export async function cleanupLoomCopies(env: Env, deleteAfterDays: number, now = Date.now()): Promise<number> {
  const last = Number(await getKv(env, CLEANUP_KEY));
  if (Number.isFinite(last) && now - last < CLEANUP_EVERY_MS) return 0;
  if (!(await loadState(env)).loom.connected) return 0;
  await putKv(env, CLEANUP_KEY, String(now));
  const cutoff = new Date(now - deleteAfterDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  const { results } = await env.DB.prepare(
    "SELECT id, loom_video_id FROM proposals WHERE loom_video_id IS NOT NULL AND loom_deleted_at IS NULL AND status IN ('submitted', 'failed', 'skipped') AND created_at < ? ORDER BY created_at LIMIT ?",
  ).bind(cutoff, CLEANUP_BATCH).all<{ id: number; loom_video_id: string }>();
  const { results: orphans } = await env.DB.prepare(`SELECT key FROM kv WHERE key LIKE 'loom:copy:%'
    AND updated_at < datetime('now', '-1 day') AND NOT EXISTS (SELECT 1 FROM proposals WHERE loom_video_id = substr(kv.key, 11)) LIMIT 10`).all<{ key: string }>();
  for (const orphan of orphans) await deleteCopy(env, orphan.key.slice('loom:copy:'.length));
  if (!results.length) return 0;
  return (await withSession(env, async (sess) => {
    let deleted = 0;
    for (const r of results) {
      try {
        if (!(await deleteVideos(sess, [r.loom_video_id]))) continue;
        deleted++;
      } catch (e) {
        if (e instanceof LoomAuthError) throw e;
        // Already gone or refused: log it and don't try again every pass.
        console.error('loom: copy not deleted', r.loom_video_id, e instanceof Error ? e.message : e);
        continue;
      }
      await env.DB.prepare("UPDATE proposals SET loom_deleted_at = datetime('now') WHERE id = ?").bind(r.id).run();
      await delKv(env, `loom:copy:${r.loom_video_id}`);
    }
    return deleted;
  })) ?? 0;
}

// Keeps the session in use (and so renewed) on quiet days. Twelve hours is inside a normal working day, so an idle
// timeout shorter than the cookie's own date does not win. One copy is made and deleted, the same check as Connect.
export async function keepLoomAlive(env: Env, sourceUrl: string, now = Date.now()): Promise<boolean> {
  const source = videoIdFrom(sourceUrl);
  if (!source || !(await loadState(env)).loom.connected) return false;
  const last = Number(await getKv(env, ACTIVE_KEY));
  if (Number.isFinite(last) && now - last < KEEP_ALIVE_MS) return false;
  await withSession(env, async (sess) => {
    const copy = await duplicate(sess, source, 'Session check (Upwork Auto-Bidder) - safe to delete');
    await deleteVideos(sess, [copy.id]);
  });
  return true;
}

// ---------- Alerts: the session expires within a week, or Loom stopped accepting it ----------

const WARN_BEFORE_MS = 7 * 86_400_000;
const STALE_RENEWAL_MS = 10 * 86_400_000;

export type LoomAlert = { key: string; subject: string; text: string };
export function loomAlert(loom: State['loom'], sentFor: string | null, now = Date.now()): LoomAlert | null {
  const steps = 'To reconnect (2 minutes): open loom.com signed in to the Loom account, press F12 → Application → Cookies → https://www.loom.com, '
    + 'copy the Value of connect.sid, then on the dashboard go to Settings → Loom video → Reconnect and paste it.';
  if (loom.connected && loom.expiresAt) {
    const left = Date.parse(loom.expiresAt) - now;
    const key = `expiring:${loom.expiresAt}`;
    if (left < WARN_BEFORE_MS && sentFor !== key) {
      const days = Math.max(0, Math.ceil(left / 86_400_000));
      const when = new Date(loom.expiresAt).toUTCString().slice(0, 16);
      return {
        key,
        subject: days ? `Loom connection expires in ${days} day${days === 1 ? '' : 's'}` : 'Loom connection has expired',
        text: `The Loom session used for the per-job video copies ${days ? 'expires on' : 'expired on'} ${when}.\n\n${steps}\n\n`
          + 'Until then nothing stops: proposals keep going out with the source video instead of their own copy.\n\nUpwork Auto-Bidder',
      };
    }
  }
  if (loom.connected && loom.renewedAt) {
    const quiet = now - Date.parse(loom.renewedAt);
    const key = `stale:${loom.renewedAt}`;
    if (quiet > STALE_RENEWAL_MS && sentFor !== key) {
      return {
        key,
        subject: 'Loom session has not refreshed in 10 days',
        text: 'Loom has not issued a new session cookie in 10 days. The date on the saved cookie can still look fine while the session stops working.\n\n'
          + `${steps}\n\nNothing is disconnected yet. Proposals keep going out.\n\nUpwork Auto-Bidder`,
      };
    }
  }
  if (!loom.connected && loom.checkedAt && loom.lastError) {
    const key = `disconnected:${loom.checkedAt}`;
    if (sentFor !== key) {
      return {
        key,
        subject: 'Loom disconnected: proposals use the source video',
        text: `Loom stopped accepting the saved session (${loom.lastError}).\n\n${steps}\n\n`
          + 'Meanwhile proposals keep going out with the source video instead of their own copy.\n\nUpwork Auto-Bidder',
      };
    }
  }
  return null;
}

// Emails the report address once per alert; without email the dashboard shows the same warning.
export async function checkLoomAlert(env: Env, now = Date.now()): Promise<void> {
  const lease = await acquireLease(env, 'loom-alert', 60_000); if (!lease) return;
  try { await deliverLoomAlert(env, now); }
  finally { await releaseLease(env, 'loom-alert', lease); }
}

async function deliverLoomAlert(env: Env, now: number): Promise<void> {
  const st = await loadState(env);
  const alert = loomAlert(st.loom, st.loomAlertSentFor, now);
  if (!alert) return;
  const s = await loadSettings(env);
  if (!emailConfigured(env) || !reportEmails(s).length) return;
  if (emailConfigured(env) && reportEmails(s).length) {
    try { await sendEmail(env, reportEmails(s), alert.subject, alert.text, undefined, `loom-${alert.key}`); }
    catch (e) { console.error('loom alert email failed', e instanceof Error ? e.message : e); return; } // retried next run
  }
  await patchState(env, { loomAlertSentFor: alert.key });
}
