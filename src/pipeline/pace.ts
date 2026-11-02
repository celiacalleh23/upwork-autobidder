import { getKv, putKv } from '../kv';
import type { Env, Mode, State } from '../settings';

// Check eligibility every minute in Auto; the persisted random wait controls actual sending.
// Review retains its five-minute checks. Discovery scheduling is independent.
export const sendDue = (minute: number, mode: Mode) => mode === 'auto' || minute % 5 === 0;

// Called under the sender lease. Anchor one random interval to the last confirmed send,
// so retries, deployments and repeated cron deliveries never redraw or shorten it.
export async function autoSendWait(env: Env, state: State, now = Date.now()): Promise<string | null> {
  if (state.mode !== 'auto' || !state.lastSendAt) return null;
  const last = Date.parse(state.lastSendAt);
  if (!Number.isFinite(last)) return null;
  const raw = await getKv(env, 'send:autoInterval');
  let saved: { last: number; minutes: number } | null = null;
  try { saved = raw ? JSON.parse(raw) : null; } catch { /* replace invalid schedule */ }
  if (!saved || saved.last !== last || !Number.isInteger(saved.minutes) || saved.minutes < 5 || saved.minutes > 16) {
    saved = { last, minutes: 5 + Math.floor(Math.random() * 12) };
    await putKv(env, 'send:autoInterval', JSON.stringify(saved));
  }
  const remaining = last + saved.minutes * 60_000 - now;
  return remaining > 0 ? `Next auto proposal in ${Math.ceil(remaining / 60_000)} min (random 5–16 min spacing).` : null;
}
