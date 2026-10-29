import { getKv } from './kv';
import type { Env } from './settings';

// Rafa's account and Keyword trends read Upwork slowly (Celia, Oct 29), so bidding keeps most of Upwork's limit
// (Oct 29: "~12 requests/min sustained for find_jobs, find_freelancers, get_profile, and write tools", refilled
// continuously). Each of their calls to those tools takes the next free 10-second slot, shared by every run through
// D1, so together they use at most 6 a minute. Bidding itself (scan, writer, sender) does not wait for these slots.

export const SLOW_GAP_MS = 10_000;
const MAX_WAIT_MS = 45_000;
const SLOT_KEY = 'upwork:slowSlot';

export class UpworkBusy extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How long Upwork asked to wait after a rate limit, in ms (its own figure plus a second), or null if it is not one.
export function throttleWait(e: unknown): number | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/rate.?limit|too many requests|\b429\b/i.test(msg)) return null;
  const m = /wait about (\d+) seconds?|retry_after\D{0,6}(\d+)/i.exec(msg);
  return Math.min(30, Number(m?.[1] ?? m?.[2] ?? 10)) * 1000 + 1000;
}

// Reserves the next slot atomically: max(previous slot + gap, now). Returns when it may run (ms epoch).
async function reserve(env: Env, now: number): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(kv.value AS INTEGER) + ?, ?) AS TEXT), updated_at = excluded.updated_at
     RETURNING value`,
  ).bind(SLOT_KEY, String(now), SLOW_GAP_MS, now).first<{ value: string }>();
  return Number(r?.value ?? now);
}

// Runs one Upwork call at the slow pace. A rate limit is waited out once, as long as Upwork asks; a second one is an
// error for the caller to show (these extras never pause bidding).
export async function paced<T>(env: Env, call: () => Promise<T>): Promise<T> {
  const queued = Number(await getKv(env, SLOT_KEY)) || 0;
  if (queued + SLOW_GAP_MS - Date.now() > MAX_WAIT_MS) throw new UpworkBusy('Upwork is busy with other reads. Try again in a minute.');
  const at = await reserve(env, Date.now());
  if (at > Date.now()) await sleep(at - Date.now());
  try {
    return await call();
  } catch (e) {
    const wait = throttleWait(e);
    if (wait === null) throw e;
    await sleep(wait);
    try { return await call(); } catch (e2) {
      if (throttleWait(e2) !== null) throw new UpworkBusy('Upwork asked to slow down. Try again in a minute; bidding is not affected.');
      throw e2;
    }
  }
}
