import type { Env } from './settings';

// Raw string values in the kv table (settings and state use the JSON helpers in settings.ts).
export async function getKv(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function putKv(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(key, value).run();
}

export const delKv = (env: Env, key: string) => env.DB.prepare('DELETE FROM kv WHERE key = ?').bind(key).run();

// A lease so two cron runs never do the same work at once. The value is the expiry (ms epoch); an expired lease can be taken.
export async function acquireLease(env: Env, name: string, ttlMs: number): Promise<boolean> {
  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE CAST(kv.value AS INTEGER) < ?`,
  ).bind(`lease:${name}`, String(now + ttlMs), now).run();
  return (r.meta.changes ?? 0) > 0;
}

export const releaseLease = (env: Env, name: string) => delKv(env, `lease:${name}`);
