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
    // 30 s slack: the cron fires every 5 minutes and a 5-minute gap should not skip a whole run.
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
