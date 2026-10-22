import { seal, unseal } from './crypto';
import { delKv, getKv, putKv } from './kv';
import { loadState, patchState, type Env, type State } from './settings';

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

async function gql<T>(cookie: string, operationName: string, query: string, variables: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie,
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

export async function duplicate(cookie: string, videoId: string, newName: string) {
  return readDuplicate(await gql<DuplicateData>(cookie, 'DuplicateVideo', DUPLICATE, { videoId, newName, spaceId: null, password: null }));
}

export async function deleteVideos(cookie: string, ids: string[]): Promise<boolean> {
  const data = await gql<{ bulkDeleteVideos?: { __typename?: string; message?: string; success?: boolean } }>(cookie, 'BulkDeleteVideos', BULK_DELETE, { videoIds: ids });
  throwIfError(data.bulkDeleteVideos, 'delete the video');
  return data.bulkDeleteVideos?.success === true;
}

// ---------- Session ----------

export async function loomCookie(env: Env): Promise<string | null> {
  const sealed = await getKv(env, SESSION_KEY);
  return sealed ? (await unseal<{ cookie: string }>(env, sealed))?.cookie ?? null : null;
}

// Proves the session can copy the source video: makes one copy and deletes it straight away.
export async function connectLoom(env: Env, pasted: string, sourceUrl: string): Promise<State> {
  const cookie = cookieFrom(pasted);
  if (!cookie) throw new LoomError('Paste the connect.sid value from loom.com (one line).');
  const source = videoIdFrom(sourceUrl);
  if (!source) throw new LoomError('Save the source video link in Settings → Loom first.');
  const copy = await duplicate(cookie, source, 'Connection test (Upwork Auto-Bidder) - safe to delete');
  await deleteVideos(cookie, [copy.id]).catch((e) => console.error('loom: test copy not deleted', e instanceof Error ? e.message : e));
  await putKv(env, SESSION_KEY, await seal(env, { cookie }));
  return patchState(env, { loom: { connected: true, lastError: null, checkedAt: new Date().toISOString() } });
}

export async function disconnectLoom(env: Env): Promise<State> {
  await delKv(env, SESSION_KEY);
  return patchState(env, { loom: { connected: false, lastError: null, checkedAt: null } });
}

export async function markLoomError(env: Env, e: unknown) {
  const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  const st = await loadState(env);
  await patchState(env, { loom: { ...st.loom, connected: e instanceof LoomAuthError ? false : st.loom.connected, lastError: msg } });
}

// A copy of the source video named after the job, for one proposal. Null when Loom is not connected.
export async function copyForJob(env: Env, sourceUrl: string, title: string): Promise<{ id: string; url: string } | null> {
  const source = videoIdFrom(sourceUrl);
  const cookie = source ? await loomCookie(env) : null;
  if (!source || !cookie) return null;
  const { id } = await duplicate(cookie, source, copyName(title));
  return { id, url: shareUrl(id) };
}

// ---------- Cleanup: delete copies older than settings.loom.deleteAfterDays, only ids this tool created ----------

const CLEANUP_KEY = 'loom:cleanupAt';
const CLEANUP_EVERY_MS = 6 * 3600_000;
const CLEANUP_BATCH = 20;

export async function cleanupLoomCopies(env: Env, deleteAfterDays: number, now = Date.now()): Promise<number> {
  const last = Number(await getKv(env, CLEANUP_KEY));
  if (Number.isFinite(last) && now - last < CLEANUP_EVERY_MS) return 0;
  const cookie = await loomCookie(env);
  if (!cookie) return 0;
  await putKv(env, CLEANUP_KEY, String(now));
  const cutoff = new Date(now - deleteAfterDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  const { results } = await env.DB.prepare(
    'SELECT id, loom_video_id FROM proposals WHERE loom_video_id IS NOT NULL AND loom_deleted_at IS NULL AND created_at < ? ORDER BY created_at LIMIT ?',
  ).bind(cutoff, CLEANUP_BATCH).all<{ id: number; loom_video_id: string }>();
  let deleted = 0;
  for (const r of results) {
    try {
      if (await deleteVideos(cookie, [r.loom_video_id])) deleted++;
    } catch (e) {
      if (e instanceof LoomAuthError) { await markLoomError(env, e); break; }
      // Already gone or refused: log it and don't try again every pass.
      console.error('loom: copy not deleted', r.loom_video_id, e instanceof Error ? e.message : e);
    }
    await env.DB.prepare("UPDATE proposals SET loom_deleted_at = datetime('now') WHERE id = ?").bind(r.id).run();
  }
  return deleted;
}
