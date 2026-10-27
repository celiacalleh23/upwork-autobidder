import { isActiveNow } from '../api';
import { McpAuthError, McpToolError } from '../mcp';
import type { Settings, State } from '../settings';
import { findKey } from '../oauth';

// Pure rules for the sender (M6): when it may send, and how to read Upwork's answers. No network, no storage.

export interface SendCounts { sentToday: number; sentLastHour: number }

// Why the sender must wait right now, or null when it may send. Connects and the job itself are checked later, live.
export function sendGate(state: State, s: Settings, counts: SendCounts, now = new Date()): string | null {
  if (!s.sendingEnabled) return 'Sending is off (Settings → Sending).';
  if (state.paused) return `Paused: ${state.pausedReason ?? 'from the dashboard'}`;
  if (!state.upwork.connected) return 'Upwork is not connected.';
  if (!isActiveNow(s.caps.activeStart, s.caps.activeEnd, s.caps.timezone, now)) return `Outside active hours (${s.caps.activeStart}–${s.caps.activeEnd}).`;
  if (s.caps.daily > 0 && counts.sentToday >= s.caps.daily) return `Daily cap reached (${s.caps.daily}).`;
  if (s.caps.hourly > 0 && counts.sentLastHour >= s.caps.hourly) return `Hourly cap reached (${s.caps.hourly}).`;
  if (state.lastSendAt) {
    const wait = s.caps.gapMinutes * 60_000 - (now.getTime() - Date.parse(state.lastSendAt));
    // 30 s slack: the sender runs on the minute (every 5 minutes in Review) and a 5-minute gap should not skip a run.
    if (wait > 30_000) return `Next proposal in ${Math.ceil(wait / 60_000)} min (${s.caps.gapMinutes} min apart).`;
  }
  return null;
}

// Connects check against the live balance and the job's cost. Returns why to wait, or null.
export function connectsGate(balance: number | null, cost: number | null, s: Settings): string | null {
  if (balance === null) return 'Could not read the Connects balance.';
  if (cost !== null && balance < cost) return `Waiting for Connects: balance ${balance}, this job costs ${cost}.`;
  if (s.caps.connectsFloorEnabled && balance - (cost ?? 0) < s.caps.connectsFloor) {
    return `Connects floor: sending would leave ${balance - (cost ?? 0)}, below ${s.caps.connectsFloor}.`;
  }
  return null;
}

export type FailureKind = 'needs_confirmation' | 'rate_limit' | 'refused' | 'ambiguous';

// How to treat an error from create or confirm. Only an answer from Upwork itself (a tool error) counts as a definite
// refusal; dropped connections, timeouts and 5xx are ambiguous because the proposal may have gone through.
export function classifyFailure(e: unknown): FailureKind {
  const msg = e instanceof Error ? e.message : String(e);
  if (/\b429\b|rate.?limit|too many requests|account (warning|restricted|suspended)|unusual activity/i.test(msg)) return 'rate_limit';
  if (/(requires?|needs?|awaiting).{0,40}(user|human|explicit).{0,20}(confirm|approv)|not (allowed|permitted) to confirm|confirmation (is )?required|permission/i.test(msg)) return 'needs_confirmation';
  if (e instanceof McpAuthError) return 'refused';
  if (e instanceof McpToolError && !/timeout|timed out|temporar|try again|\b5\d\d\b|internal error|unavailable/i.test(msg)) return 'refused';
  return 'ambiguous';
}

export type ConfirmOutcome = { ok: true; proposalId: string | null } | { ok: false; message: string };

// confirm_preview answers status "submitted" and data.createJobProposal{status: "SUCCESS", newProposalId, error}.
export function readConfirm(r: unknown): ConfirmOutcome {
  const created = findKey(r, 'createJobProposal') as Record<string, unknown> | undefined;
  const status = String(created?.status ?? findKey(r, 'status') ?? '').toUpperCase();
  const id = created?.newProposalId ?? findKey(r, 'newProposalId') ?? findKey(r, 'proposal_id');
  const error = created?.error ?? findKey(r, 'error');
  if ((status === 'SUCCESS' || status === 'SUBMITTED') && !error) return { ok: true, proposalId: id === undefined || id === null ? null : String(id) };
  const message = typeof error === 'string' ? error : error ? JSON.stringify(error) : `Upwork answered: ${JSON.stringify(r ?? '').slice(0, 200)}`;
  return { ok: false, message: message.slice(0, 300) };
}

// Low-Connects alert: once per drop below the threshold; re-armed when the balance is back at or above it.
export function alertAction(balance: number | null, threshold: number, sentAt: string | null): 'send' | 'reset' | null {
  if (!threshold || balance === null) return null;
  if (balance < threshold) return sentAt ? null : 'send';
  return sentAt ? 'reset' : null;
}

// The preview's boost block: boosting is a Connects bid for a top slot on the client's list, charged only if the
// proposal lands in a paid slot (or the client engages it before the auction closes).
export interface BoostInfo { available: boolean; recommended: number | null; max: number | null; skip: boolean }

export function readBoost(b: unknown): BoostInfo | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  const n = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return { available: o.available === true, recommended: n(o.recommended_connects), max: n(o.max_boost_connects), skip: String(o.recommendation ?? '').toLowerCase() === 'skip' };
}

// Connects to bid on a boost (Siv, Oct 27: strong matches only), or null for no boost. The bid is Upwork's recommended
// one, the smallest that takes a top slot, within the per-job maximum, the balance left after the job's own cost and
// the Connects floor when it is on. `left` is the balance minus the job's cost, when known.
export function boostBid(score: number | null, b: BoostInfo | null, s: Settings, left: number | null): number | null {
  const c = s.caps;
  if (!c.boostEnabled || score === null || score < c.boostMinScore) return null;
  if (!b || !b.available || b.skip || b.recommended === null) return null;
  const bid = Math.max(1, Math.ceil(b.recommended));
  if (bid > c.boostMaxConnects || (b.max !== null && bid > b.max)) return null;
  if (left !== null && bid > left - (c.connectsFloorEnabled ? c.connectsFloor : 0)) return null;
  return bid;
}

// Upwork re-reads the bids at confirm and refuses (sends nothing) when the boost no longer takes a paid slot.
export const isBoostRefusal = (message: string) => /paid slot|bids? to beat|outbid|boost/i.test(message);
