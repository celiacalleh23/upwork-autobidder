import { getKv, putKv } from '../kv';
import type { Env, Mode, State } from '../settings';

// Check eligibility every minute in Auto; the persisted random wait controls actual sending.
// Review retains its five-minute checks. Discovery scheduling is independent.
// Review normally checks every five minutes. A proposal a person just approved is due on the next minute.
export const sendDue = (minute: number, mode: Mode, manualWaiting = false) => mode === 'auto' || manualWaiting || minute % 5 === 0;

// Called under the sender lease. Anchor one random interval to the last confirmed send,
// so retries, deployments and repeated cron deliveries never redraw or shorten it.
export async function autoSendWait(env: Env, state: State, now = Date.now()): Promise<string | null> {
  if (state.mode !== 'auto' || !state.lastSendAt) return null;
  const last = Date.parse(state.lastSendAt);
  if (!Number.isFinite(last)) return null;
  const raw = await getKv(env, 'send:autoInterval');
  let saved: { last: number; minutes: number } | null = null;
  try { saved = raw ? JSON.parse(raw) : null; } catch { /* replace invalid schedule */ }
  if (!saved || saved.last !== last || !Number.isInteger(saved.minutes) || saved.minutes < 3 || saved.minutes > 9) {
    saved = { last, minutes: 3 + Math.floor(Math.random() * 7) };
    await putKv(env, 'send:autoInterval', JSON.stringify(saved));
  }
  const remaining = last + saved.minutes * 60_000 - now;
  return remaining > 0 ? `Next auto proposal in ${Math.ceil(remaining / 60_000)} min (random / humanized 3–9 min spacing).` : null;
}
