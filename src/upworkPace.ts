import { delKv, getKv, putKv } from './kv';
import { throttleWait } from './mcp';
import { patchState, type Env } from './settings';

// Rafa's account and Keyword trends read Upwork slowly (Celia, Oct 29), so bidding keeps most of Upwork's limit
// (Oct 29: "~12 requests/min sustained for find_jobs, find_freelancers, get_profile, and write tools", refilled
// continuously). Each of their calls to those tools takes the next free 10-second slot, shared by every run through
// D1, so together they use at most 6 a minute. Bidding itself (scan, writer, sender) does not wait for these slots.

export const SLOW_GAP_MS = 10_000;
const MAX_WAIT_MS = 45_000;
const SLOT_KEY = 'upwork:slowSlot';

export class UpworkBusy extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reserves the next slot atomically: max(previous slot + gap, now). Returns when it may run (ms epoch).
async function reserve(env: Env, now: number): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(kv.value AS INTEGER) + ?, ?) AS TEXT), updated_at = excluded.updated_at
     RETURNING value`,
  ).bind(SLOT_KEY, String(now), SLOW_GAP_MS, now).first<{ value: string }>();
  return Number(r?.value ?? now);
}

// Runs one Upwork call at the slow pace. The client already waits out one rate limit (mcp.ts); a second one is an error
// for the caller to show (these extras never pause bidding).
export async function paced<T>(env: Env, call: () => Promise<T>): Promise<T> {
  const queued = Number(await getKv(env, SLOT_KEY)) || 0;
  if (queued + SLOW_GAP_MS - Date.now() > MAX_WAIT_MS) throw new UpworkBusy('Upwork is busy with other reads. Try again in a minute.');
  const at = await reserve(env, Date.now());
  if (at > Date.now()) await sleep(at - Date.now());
  try {
    return await call();
  } catch (e) {
    if (throttleWait(e) !== null) throw new UpworkBusy('Upwork asked to slow down. Try again in a minute; bidding is not affected.');
    throw e;
  }
}

// Bidding and Upwork's per-minute limit (Celia, Oct 29): a call already waited and retried once (mcp.ts); a run still
// turned away ends and the next run tries again. Only THROTTLE_PAUSE_AFTER such runs in a row pause bidding (a clean
// scan starts the count over); an account warning still pauses at once (BUILD_PLAN §2).
const THROTTLE_KEY = 'upwork:throttledRuns';
export const THROTTLE_PAUSE_AFTER = 3;
export const isThrottle = (e: unknown) => throttleWait(e) !== null;

export async function noteThrottle(env: Env, where: string, msg: string): Promise<boolean> {
  const n = (Number(await getKv(env, THROTTLE_KEY)) || 0) + 1;
  if (n < THROTTLE_PAUSE_AFTER) { await putKv(env, THROTTLE_KEY, String(n)); return false; }
  await delKv(env, THROTTLE_KEY);
  await patchState(env, { paused: true, pausedReason: `Upwork kept asking to slow down (${n} rounds in a row, last during ${where}): ${msg.slice(0, 200)}` });
  return true;
}

export async function clearThrottle(env: Env): Promise<void> {
  if (await getKv(env, THROTTLE_KEY)) await delKv(env, THROTTLE_KEY);
}
