import { timingSafeEqual } from '../auth';
import { readObject } from '../http';
import { checkUpwork, finishUpworkAuth, paramsFromPasted, scanConnection, startUpworkAuth } from '../oauth';
import { scanAccount } from '../pipeline/scan';
import { DEFAULT_SETTINGS, DEFAULT_STATE, loadSettings, loadState, patchState } from '../settings';
import { putKv } from '../kv';
import { drainDeliveries, enqueueJob, outboxSchema, type ScannerEnv } from './delivery';

// This entry point has no writer, sender, Loom, Claude, or bidding-account API routes.
async function initialize(env: ScannerEnv) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(outboxSchema),
    env.DB.prepare("INSERT OR IGNORE INTO kv(key,value) VALUES ('state',?)").bind(JSON.stringify({ ...DEFAULT_STATE, paused: true })),
  ]);
}
export default {
  async fetch(req: Request, env: ScannerEnv): Promise<Response> {
    const secret = env.SCANNER_ADMIN_SECRET ?? '';
    if (secret.length < 32) return new Response(null, { status: 503 });
    if (!timingSafeEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`)) return new Response(null, { status: 401 });
    await initialize(env);
    const path = new URL(req.url).pathname;
    try {
      if (req.method === 'GET' && path === '/status') {
        const backlog = await env.DB.prepare('SELECT COUNT(*) AS pending, MIN(next_at) AS nextAt FROM scan_outbox WHERE delivered_at IS NULL').first();
        return Response.json({ paused: (await loadState(env)).paused, connection: await scanConnection(env), backlog }, { headers: { 'cache-control': 'no-store' } });
      }
      if (req.method !== 'POST') return new Response(null, { status: 405 });
      const body = await readObject(req);
      if (path === '/oauth/start') return Response.json({ url: await startUpworkAuth(env, new URL(req.url).origin, 'scan') });
      if (path === '/oauth/finish') {
        await finishUpworkAuth(env, paramsFromPasted(String(body.callback ?? '')), 'scan');
        await checkUpwork(env, 'scan');
        return Response.json({ connected: true });
      }
      if (path === '/settings') {
        if (!Array.isArray(body.keywords) || body.keywords.length > 100 || !body.keywords.every(k => typeof k === 'string' && k.trim().length > 0 && k.length <= 100) || typeof body.verifiedOnly !== 'boolean') return new Response(null, { status: 400 });
        // Only discovery settings exist here; do not invoke primary settings sync side effects.
        await putKv(env, 'settings', JSON.stringify({ ...DEFAULT_SETTINGS, keywords: body.keywords, verifiedOnly: body.verifiedOnly }));
        return Response.json({ saved: true });
      }
      if (path === '/pause' && typeof body.paused === 'boolean') {
        if (!body.paused && !(await loadSettings(env)).keywords.length) return new Response('Configure keywords first', { status: 400 });
        await patchState(env, { paused: body.paused, pausedReason: null });
        return Response.json({ paused: body.paused });
      }
      return new Response(null, { status: 404 });
    } catch {
      return Response.json({ error: 'Operation failed; check configuration and connection' }, { status: 400 });
    }
  },
  async scheduled(event: ScheduledController, env: ScannerEnv): Promise<void> {
    await initialize(env);
    // Retries have their own minute-by-minute cron and do not consume Upwork requests.
    if (event.cron === '* * * * *') {
      await env.DB.prepare("DELETE FROM kv WHERE key IN (SELECT key FROM kv WHERE key LIKE 'upwork:scanSearch:%' AND CAST(value AS INTEGER) < ? LIMIT 100)").bind(Date.now() - 2 * 86400_000).run();
      await drainDeliveries(env); return;
    }
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (event.cron === '15,45 * * * *' && minute % 30 === 15) await scanAccount(env, event.scheduledTime, 'scan', enqueueJob);
  },
};
