import { timingSafeEqual } from '../auth';
import { readObject, readResponseBody } from '../http';
import { acquireLease, ownsLease, releaseLease } from '../kv';
import { addJob, jobIdFromUrl, jobUrl } from '../pipeline/jobs';
import type { Env } from '../settings';

export interface ScannerEnv extends Env {
  SCANNER_ADMIN_SECRET?: string;
  JOB_DELIVERY_URL?: string;
  JOB_DELIVERY_SECRET?: string;
}
export const outboxSchema = `CREATE TABLE IF NOT EXISTS scan_outbox (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0, delivered_at INTEGER, last_error TEXT
)`;

// Persist before advancing discovery's keyword cursor. Never overwrite a receipt on rediscovery.
export const enqueueJob: typeof addJob = async (env, input) => {
  const id = jobIdFromUrl(String(input.jobUrl ?? ''));
  if (!id) return { ok: false, id: null, reason: 'Invalid job' };
  await env.DB.prepare(`INSERT OR IGNORE INTO scan_outbox(id,payload) VALUES (?,?)`)
    .bind(id, JSON.stringify({ jobUrl: jobUrl(id), title: input.title, postedAt: input.postedAt })).run();
  return { ok: true, id, status: 'added' };
};

export async function drainDeliveries(env: ScannerEnv): Promise<void> {
  if (!env.JOB_DELIVERY_URL || (env.JOB_DELIVERY_SECRET ?? '').length < 32) return;
  const url = new URL(env.JOB_DELIVERY_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/api/jobs/scan-intake' || url.search || url.hash) throw new Error('Invalid scanner delivery URL');
  const token = await acquireLease(env, 'scan-delivery', 120_000);
  if (!token) return;
  try {
    const { results } = await env.DB.prepare(`SELECT id,payload,attempts FROM scan_outbox
      WHERE delivered_at IS NULL AND next_at <= ? ORDER BY next_at,id LIMIT 5`)
      .bind(Date.now()).all<{ id: string; payload: string; attempts: number }>();
    for (const row of results) {
      if (!await ownsLease(env, 'scan-delivery', token)) break;
      try {
        const res = await fetch(url, { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.JOB_DELIVERY_SECRET}` },
          body: row.payload, signal: AbortSignal.timeout(15_000) });
        const ack = await readResponseBody(res, 8192).catch(() => null) as { id?: unknown; accepted?: unknown } | null;
        if (!res.ok || ack?.id !== row.id || ack?.accepted !== true) throw new Error(`Delivery not acknowledged (HTTP ${res.status})`);
        await env.DB.prepare('UPDATE scan_outbox SET delivered_at=?,last_error=NULL WHERE id=?').bind(Date.now(), row.id).run();
      } catch {
        // Keep all failures, including auth/configuration failures, for retry after repair.
        const delay = Math.min(3600_000, 60_000 * 2 ** Math.min(row.attempts, 6));
        await env.DB.prepare('UPDATE scan_outbox SET attempts=attempts+1,next_at=?,last_error=? WHERE id=?')
          .bind(Date.now() + delay, 'Delivery failed; check receiver and credentials', row.id).run();
      }
    }
  } finally { await releaseLease(env, 'scan-delivery', token); }
}

export async function receiveScanJob(req: Request, env: Env, ensureSchema: () => Promise<void>): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const secret = env.SCAN_INTAKE_SECRET ?? '';
  if (secret.length < 32) return new Response(null, { status: 503 });
  if (!timingSafeEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`)) return new Response(null, { status: 401 });
  const body = await readObject(req).catch(() => null);
  const id = jobIdFromUrl(String(body?.jobUrl ?? ''));
  if (!id) return new Response(null, { status: 400 });
  await ensureSchema();
  const result = await addJob(env, { jobUrl: jobUrl(id), title: body?.title, postedAt: body?.postedAt, automatic: true });
  if (!result.ok && result.retryable) return Response.json({ accepted: false, id }, { status: 429 });
  return Response.json({ accepted: true, id }, { status: 202, headers: { 'cache-control': 'no-store' } });
}
