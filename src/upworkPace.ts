import { delKv, getKv, putKv } from './kv';
import { isAccountWarning, throttleWait } from './mcp';
import { loadState, patchState, type Env, type State } from './settings';

// Rafa's account reads Upwork slowly (Celia, Oct 29), so bidding keeps most of Upwork's limit
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

// An Upwork restriction or account warning (BUILD_PLAN §2; Oct 30: search restricted for Terms of Service violations):
// bidding pauses at once and every Upwork call (bidding, upkeep and the extras) stays stopped until someone resumes,
// since retrying can make a restriction worse.
export const WARNING_PREFIX = 'Upwork restricted or warned the account';
export const heldByUpwork = (st: State) => st.paused && (st.pausedReason ?? '').startsWith(WARNING_PREFIX);
export async function pauseForWarning(env: Env, where: string, msg: string): Promise<void> {
  await patchState(env, {
    paused: true,
    pausedReason: `${WARNING_PREFIX} (${where}): ${msg.slice(0, 300)} — Nothing is searched or sent until you resume. Check Rafa's Upwork messages and support first.`,
  });
}

// Runs one Upwork call at the slow pace. The client already waits out one rate limit (mcp.ts); a second one is an error
// for the caller to show (these extras never pause bidding, except for an Upwork warning).
export async function paced<T>(env: Env, call: () => Promise<T>): Promise<T> {
  if (heldByUpwork(await loadState(env))) throw new UpworkBusy('Paused: Upwork restricted or warned the account.');
  return call(); // Authenticated McpClient now budgets all callers, including bidding.
}

export async function permitUpworkCall(env: Env, budgeted: boolean): Promise<void> {
  if (heldByUpwork(await loadState(env))) throw new UpworkBusy('Paused: Upwork restricted or warned the account.');
  if (Number(await getKv(env, 'upwork:retryAt')) > Date.now()) throw new UpworkBusy('Upwork asked to slow down; waiting for the requested retry time.');
  if (!budgeted) return;
  const at = await reserve(env, Date.now());
  if (at - Date.now() > MAX_WAIT_MS) throw new UpworkBusy('Upwork is busy; retry on a later run.');
  if (at > Date.now()) await sleep(at - Date.now());
  if (heldByUpwork(await loadState(env))) throw new UpworkBusy('Paused: Upwork restricted or warned the account.');
  if (Number(await getKv(env, 'upwork:retryAt')) > Date.now()) throw new UpworkBusy('Upwork asked to slow down; retry later.');
}

export async function recordUpworkError(env: Env, e: unknown): Promise<void> {
  const msg = e instanceof Error ? e.message : String(e);
  if (isAccountWarning(msg)) await pauseForWarning(env, 'an Upwork request', msg);
  const wait = throttleWait(e);
  if (wait !== null) {
    await env.DB.prepare(`INSERT INTO kv (key, value) VALUES ('upwork:retryAt', ?)
      ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(kv.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`)
      .bind(String(Date.now() + wait)).run();
  }
}

// Bidding and Upwork's per-minute limit (Celia, Oct 29): a call already waited and retried once (mcp.ts); a run still
// turned away ends and the next run tries again. Only THROTTLE_PAUSE_AFTER such runs in a row pause bidding (a clean
// scan starts the count over); an account warning still pauses at once (BUILD_PLAN §2).
const THROTTLE_KEY = 'upwork:throttledRuns';
export const THROTTLE_PAUSE_AFTER = 3;
export const isThrottle = (e: unknown) => throttleWait(e) !== null;

export async function noteThrottle(env: Env, where: string, msg: string): Promise<boolean> {
  const counter = await env.DB.prepare(`INSERT INTO kv (key,value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) RETURNING value`).bind(THROTTLE_KEY).first<{ value: string }>();
  const n = Number(counter?.value ?? 1);
  if (n < THROTTLE_PAUSE_AFTER) return false;
  await delKv(env, THROTTLE_KEY);
  await patchState(env, { paused: true, pausedReason: `Upwork kept asking to slow down (${n} rounds in a row, last during ${where}): ${msg.slice(0, 200)}` });
  return true;
}

export async function clearThrottle(env: Env): Promise<void> {
  if (await getKv(env, THROTTLE_KEY)) await delKv(env, THROTTLE_KEY);
}

// Search attempts, including retries, use shared rolling quotas confirmed by the account owner.
export async function permitSearch(env: Env, scanOnly = false): Promise<void> {
  const now = Date.now();
  const prefix = scanOnly ? 'upwork:scanSearch:' : 'upwork:search:';
  const r = await env.DB.prepare(`INSERT INTO kv(key,value)
    SELECT ?, ? WHERE
      (SELECT COUNT(*) FROM kv WHERE key LIKE ? AND CAST(value AS INTEGER) > ?) < 15
      AND (SELECT COUNT(*) FROM kv WHERE key LIKE ? AND CAST(value AS INTEGER) > ?) < 150
      AND (SELECT COUNT(*) FROM kv WHERE key LIKE ? AND CAST(value AS INTEGER) > ?) < 750`)
    .bind(`${prefix}${crypto.randomUUID()}`, String(now), `${prefix}%`, now - 60_000, `${prefix}%`, now - 3600_000, `${prefix}%`, now - 86400_000).run();
  if (!r.meta.changes) throw new UpworkBusy('Upwork search quota reached; discovery waits for a later scan.');
}
