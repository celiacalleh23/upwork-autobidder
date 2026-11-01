import { timingSafeEqual } from './auth';
import { sha256b64url } from './crypto';
import { readBody, readResponseBody } from './http';
import { acquireLease, getKv, ownsLease, putKv, releaseLease } from './kv';
import { addJob } from './pipeline/jobs';
import { InvalidInput, type Env, type Settings } from './settings';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue | null => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : null;
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const validTaskId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}(?:~[A-Za-z0-9_-]{1,80})?$/.test(v);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
interface Receipt { dataset: string | null; items: unknown[]; offset: number; imported: number; duplicates: number; rejected: number; status: 'pending' | 'done' | 'error'; nextAt: number; error: string | null }

// Accept only supported variants, rather than searching arbitrarily nested untrusted objects.
export function parseDelivery(payload: unknown): Pick<Receipt, 'dataset' | 'items'> {
  const p = object(payload), resource = object(p?.resource), data = object(p?.eventData);
  if (p?.eventType !== undefined && p.eventType !== 'ACTOR.RUN.SUCCEEDED') throw new InvalidInput('Only successful actor runs are imported');
  const dataset = resource?.defaultDatasetId ?? data?.defaultDatasetId ?? p?.defaultDatasetId;
  if (dataset !== undefined) {
    if (!validId(dataset)) throw new InvalidInput('Invalid dataset ID');
    return { dataset, items: [] };
  }
  const items = Array.isArray(payload) ? payload : Array.isArray(p?.items) ? p.items : p ? [p] : [];
  if (!items.length || items.length > 100) throw new InvalidInput('Supply between 1 and 100 job items, or a successful dataset notification');
  if (!items.some(v => { const j = object(v); return j && (j.url || j.link || j.jobUrl); })) throw new InvalidInput('No job links found');
  return { dataset: null, items };
}

export async function receiveApify(req: Request, env: Env, initialize: () => Promise<void>): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.APIFY_WEBHOOK_SECRET || env.APIFY_WEBHOOK_SECRET.length < 32) return json({ error: 'Webhook authentication is not configured' }, 503);
  if (!timingSafeEqual(req.headers.get('authorization') ?? '', `Bearer ${env.APIFY_WEBHOOK_SECRET}`)) return json({ error: 'Unauthorized' }, 401);
  try {
    const payload = await readBody(req, 128_000);
    const parsed = parseDelivery(payload);
    const p = object(payload), resource = object(p?.resource);
    // Dataset identity makes run-notification retries idempotent even if provider metadata changes.
    const identity = parsed.dataset ? `${resource?.id ?? ''}:${parsed.dataset}` : JSON.stringify(payload);
    const key = `apify:receipt:${await sha256b64url(identity)}`;
    await initialize();
    const receipt: Receipt = { ...parsed, offset: 0, imported: 0, duplicates: 0, rejected: 0, status: 'pending', nextAt: 0, error: null };
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)").bind(key, JSON.stringify(receipt)).run();
    return json({ accepted: true, duplicate: !inserted.meta.changes, receipt: key.slice('apify:receipt:'.length) }, 202);
  } catch (e) {
    if (e instanceof InvalidInput || e instanceof SyntaxError) return json({ error: e instanceof InvalidInput ? e.message : 'Invalid JSON' }, 400);
    console.error('Apify receipt persistence failed');
    return json({ error: 'Delivery was not saved; retry later' }, 503);
  }
}

const headers = (env: Env) => ({ authorization: `Bearer ${env.APIFY_TOKEN}`, 'content-type': 'application/json' });
async function apifyJson(env: Env, path: string, init: RequestInit = {}): Promise<unknown> {
  if (!env.APIFY_TOKEN) throw new Error('APIFY_TOKEN is missing');
  const res = await fetch(`https://api.apify.com/v2/${path}`, { ...init, headers: headers(env), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Apify request failed (${res.status})`);
  return readResponseBody(res);
}

// One bounded import per writer tick. A receipt is acknowledged before AI or any billable pipeline work.
export async function drainApify(env: Env): Promise<void> {
  const lease = await acquireLease(env, 'apify-import', 90_000);
  if (!lease) return;
  try {
    const row = await env.DB.prepare("SELECT key, value FROM kv WHERE key LIKE 'apify:receipt:%' AND json_extract(value, '$.status') != 'done' AND COALESCE(json_extract(value, '$.nextAt'), 0) <= ? ORDER BY updated_at, key LIMIT 1")
      .bind(Date.now()).first<{ key: string; value: string }>();
    if (!row) return;
    const receipt = JSON.parse(row.value) as Receipt;
    try {
      const page = receipt.dataset
        ? await apifyJson(env, `datasets/${receipt.dataset}/items?offset=${receipt.offset}&limit=20&clean=true`)
        : receipt.items.slice(receipt.offset, receipt.offset + 20);
      if (!Array.isArray(page) || page.length > 20) throw new Error('Unexpected dataset page');
      for (const value of page) {
        if (!(await ownsLease(env, 'apify-import', lease))) return;
        const j = object(value);
        const raw = j?.url ?? j?.link ?? j?.jobUrl;
        const url = object(raw)?.href ?? object(raw)?.url ?? raw;
        const result = await addJob(env, { jobUrl: url, title: j?.title ?? j?.jobTitle, postedAt: j?.publishedDate ?? j?.postedAt ?? j?.published_date, automatic: true });
        if (!result.ok && result.retryable) throw new Error(result.reason);
        if (result.ok) receipt.imported++;
        else if (result.id) receipt.duplicates++;
        else receipt.rejected++;
        receipt.offset++;
        // Per-item checkpoint: interruption can replay only an idempotent canonical job insert.
        await putKv(env, row.key, JSON.stringify(receipt));
      }
      receipt.status = page.length < 20 || (!receipt.dataset && receipt.offset >= receipt.items.length) ? 'done' : 'pending';
      if (receipt.status === 'done') receipt.items = [];
      receipt.error = null; receipt.nextAt = 0;
    } catch (e) {
      receipt.status = 'error'; receipt.error = e instanceof Error ? e.message : 'Import failed'; receipt.nextAt = Date.now() + 5 * 60_000;
    }
    await putKv(env, row.key, JSON.stringify(receipt));
    await putKv(env, 'apify:lastImport', JSON.stringify({ at: new Date().toISOString(), ...receipt, items: undefined, dataset: undefined }));
  } finally { await releaseLease(env, 'apify-import', lease); }
}

interface Sync { revision: string; input: ObjectValue; status: 'pending' | 'applied' | 'error'; error: string | null; nextAt: number; appliedAt: string | null }
export function discoveryInput(s: Settings): ObjectValue {
  return { query: s.keywords.map(k => `"${k.replaceAll('"', '').trim()}"`).join(' OR '), location: s.allowedCountries.map(c => c === 'SWE' ? 'Sweden' : c),
    paymentVerified: s.verifiedOnly, fixedPriceRange: [s.minFixedBudget], hourlyRateRange: [s.minHourlyRate], maxJobAge: { value: 60, unit: 'minutes' } };
}
// The dashboard owns search terms, countries, verification and minimum budgets only.
// Use the hybrid 60-minute window; preserve maximum budgets, job types, cookies and schedule.
export function mergeDiscoveryInput(existing: ObjectValue, managed: ObjectValue): ObjectValue {
  const desired = { ...existing, ...managed };
  for (const key of ['fixedPriceRange', 'hourlyRateRange']) {
    const minimum = (managed[key] as number[] | undefined)?.[0];
    if (minimum === undefined) continue;
    const range = existing[key];
    if (range === undefined) {
      // Recover the user's previously chosen ceilings after Restore example input.
      const ceiling = key === 'fixedPriceRange' ? 100000 : 1000;
      if (minimum > ceiling) throw new Error(`Dashboard minimum exceeds the recovery ${key} ceiling. Configure the task ceiling explicitly.`);
      desired[key] = [minimum, ceiling];
      continue;
    }
    if (!Array.isArray(range) || range.length !== 2 || typeof range[1] !== 'number' || !Number.isFinite(range[1]) || range[1] < 0) {
      throw new Error(`Configure ${key} in the Apify task before synchronizing its minimum; its ceiling will not be guessed.`);
    }
    if (minimum > range[1]) throw new Error(`Dashboard minimum exceeds the existing Apify ${key} ceiling. Review both filters.`);
    desired[key] = [minimum, range[1]];
  }
  return desired;
}

export function syncStatement(env: Env, settings: Settings): D1PreparedStatement {
  const desired: Sync = { revision: crypto.randomUUID(), input: discoveryInput(settings), status: 'pending', error: null, nextAt: 0, appliedAt: null };
  return env.DB.prepare(`INSERT INTO kv (key,value,updated_at) VALUES ('apify:sync',?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(JSON.stringify(desired));
}
export async function requestApifySync(env: Env, settings: Settings): Promise<void> {
  await syncStatement(env, settings).run();
}
export async function apifySyncStatus(env: Env) {
  const raw = await getKv(env, 'apify:sync'), last = await getKv(env, 'apify:lastImport');
  const s = raw ? JSON.parse(raw) as Sync : null;
  return { configured: Boolean(env.APIFY_TOKEN && validTaskId(env.APIFY_TASK_ID)), configurationError: !env.APIFY_TOKEN ? 'APIFY_TOKEN is missing' : !validTaskId(env.APIFY_TASK_ID) ? 'APIFY_TASK_ID is missing or invalid (use a task ID or owner~task-name)' : null, status: s?.status ?? 'not-requested', error: s?.error ?? null, appliedAt: s?.appliedAt ?? null, lastImport: last ? JSON.parse(last) : null };
}
export async function syncApify(env: Env): Promise<void> {
  if (!env.APIFY_TOKEN || !validTaskId(env.APIFY_TASK_ID)) return;
  const lease = await acquireLease(env, 'apify-sync', 60_000);
  if (!lease) return;
  try {
    const raw = await getKv(env, 'apify:sync'); if (!raw) return;
    const s = JSON.parse(raw) as Sync;
    if (s.status === 'applied' || s.nextAt > Date.now()) return;
    try {
      // Manage task input only. Schedules, actor versions, proxies and other input keys are preserved.
      const path = `actor-tasks/${env.APIFY_TASK_ID}/input`;
      const existing = object(await apifyJson(env, path));
      if (!existing) throw new Error('Task input is not an object');
      const desired = mergeDiscoveryInput(existing, s.input);
      await apifyJson(env, path, { method: 'PUT', body: JSON.stringify(desired) });
      const verified = object(await apifyJson(env, path));
      if (!verified || Object.keys(s.input).some(k => JSON.stringify(verified[k]) !== JSON.stringify(desired[k]))) throw new Error('Apify did not confirm the saved input');
      s.status = 'applied'; s.appliedAt = new Date().toISOString(); s.error = null;
    } catch (e) { s.status = 'error'; s.error = e instanceof Error ? e.message : 'Sync failed'; s.nextAt = Date.now() + 5 * 60_000; }
    // A slow request cannot acknowledge or overwrite a newer desired revision.
    await env.DB.prepare("UPDATE kv SET value = ?, updated_at = datetime('now') WHERE key = 'apify:sync' AND json_extract(value, '$.revision') = ?")
      .bind(JSON.stringify(s), s.revision).run();
  } finally { await releaseLease(env, 'apify-sync', lease); }
}
