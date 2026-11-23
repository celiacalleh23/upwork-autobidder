import { isActiveNow } from '../api';
import { isAccountWarning, McpAuthError, McpToolError } from '../mcp';
import type { Settings, State } from '../settings';
import { findKey } from '../oauth';

// Pure rules for the sender (M6): when it may send, and how to read Upwork's answers. No network, no storage.

export interface SendCounts { sentToday: number; sentLastHour: number }

// Why the sender must wait right now, or null when it may send. Connects and the job itself are checked later, live.
export function sendGate(state: State, s: Settings, counts: SendCounts, now = new Date(), manual = false): string | null {
  if (!s.sendingEnabled) return 'Sending is off (Settings → Sending).';
  if (state.paused) return `Paused: ${state.pausedReason ?? 'from the dashboard'}`;
  if (!state.upwork.connected) return 'Upwork is not connected.';
  if (!isActiveNow(s.caps.activeStart, s.caps.activeEnd, s.caps.timezone, now)) return `Outside active hours (${s.caps.activeStart}–${s.caps.activeEnd}).`;
  if (s.caps.daily > 0 && counts.sentToday >= s.caps.daily) return `Daily cap reached (${s.caps.daily}).`;
  if (s.caps.hourly > 0 && counts.sentLastHour >= s.caps.hourly) return `Hourly cap reached (${s.caps.hourly}).`;
  // The configured gap spaces automatic sends. A person who clicked Approve is not held for it.
  if (!manual && state.lastSendAt) {
    const wait = s.caps.gapMinutes * 60_000 - (now.getTime() - Date.parse(state.lastSendAt));
    // 30 s slack: the sender runs on the minute (every 5 minutes in Review) and a 5-minute gap should not skip a run.
    if (wait > 0) return `Next proposal in ${Math.ceil(wait / 60_000)} min (${s.caps.gapMinutes} min apart).`;
  }
  return null;
}

// Connects check against the live balance and the job's cost. Returns why to wait, or null.
export function connectsGate(balance: number | null, cost: number | null, s: Settings): string | null {
  if (balance === null || !Number.isFinite(balance) || balance < 0) return 'Could not read the Connects balance.';
  if (cost === null || !Number.isFinite(cost) || cost < 0) return 'Could not read the Connects cost.';
  if (cost !== null && balance < cost) return `Waiting for Connects: balance ${balance}, this job costs ${cost}.`;
  if (s.caps.connectsFloorEnabled && balance - (cost ?? 0) < s.caps.connectsFloor) {
    return `Connects floor: sending would leave ${balance - (cost ?? 0)}, below ${s.caps.connectsFloor}.`;
  }
  return null;
}

// warning: an account warning (pause everything); throttle: Upwork's per-minute limit, nothing done (try again next run).
// transient: Upwork's tool answered with a retryable upstream outage. Nothing was decided about the job or the proposal.
export type FailureKind = 'needs_confirmation' | 'warning' | 'throttle' | 'refused' | 'ambiguous' | 'transient';

interface ToolErrorDetail { error_code?: string; reason?: string; retryable?: boolean }

// Tool text is sliced to 300 characters, so a long payload may not parse. The fields that matter are at the front.
function toolErrorDetail(msg: string): ToolErrorDetail | null {
  const start = msg.indexOf('{');
  if (start < 0) return null;
  const slice = msg.slice(start);
  const from = (value: unknown): ToolErrorDetail | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const o = value as Record<string, unknown>;
    const error_code = typeof o.error_code === 'string' ? o.error_code : undefined;
    const reason = typeof o.reason === 'string' ? o.reason : undefined;
    const retryable = o.retryable === true ? true : o.retryable === false ? false : undefined;
    if (error_code === undefined && reason === undefined && retryable === undefined) return null;
    return { error_code, reason, retryable };
  };
  try { return from(JSON.parse(slice)); } catch { /* truncated tool text */ }
  const error_code = /"error_code"\s*:\s*"([^"]*)"/.exec(slice)?.[1];
  const reason = /"reason"\s*:\s*"([^"]*)"/.exec(slice)?.[1];
  const flag = /"retryable"\s*:\s*(true|false)/.exec(slice)?.[1];
  return from({
    ...(error_code !== undefined ? { error_code } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(flag !== undefined ? { retryable: flag === 'true' } : {}),
  });
}

// The outage from find_jobs get: {"error_code":"UPSTREAM","reason":"upstream service error","retryable":true,...}
// retryable:false is Upwork saying not to retry. The same wording still counts when that flag was cut off.
export function isTransientUpstream(e: unknown): boolean {
  if (!(e instanceof McpToolError)) return false;
  const detail = toolErrorDetail(e.message);
  if (detail?.retryable === false) return false;
  const code = detail?.error_code?.toUpperCase() ?? '';
  const upstream = code === 'UPSTREAM' || /upstream service error/i.test(detail?.reason ?? '') || /upstream service error/i.test(e.message);
  return upstream && (detail?.retryable === true || code === 'UPSTREAM' || /upstream service error/i.test(e.message));
}

const CLOSED_JOB = /not found|no longer available|no longer exists|does not exist|doesn't exist|has been removed|job (?:is |has been |was )?closed|no longer accepting|\b404\b/i;
const CLOSED_CODES = new Set(['NOT_FOUND', 'JOB_NOT_FOUND', 'RESOURCE_NOT_FOUND', 'GONE', 'CLOSED', 'JOB_CLOSED', 'JOB_IS_NO_LONGER_AVAILABLE', 'NO_LONGER_AVAILABLE']);

// A definite "this job is gone" answer. A retryable upstream outage is not one, even if the text mentions a lookup failure.
export function isJobClosedOrMissing(e: unknown): boolean {
  if (isTransientUpstream(e)) return false;
  const msg = e instanceof Error ? e.message : String(e);
  const code = toolErrorDetail(msg)?.error_code?.toUpperCase().replace(/[\s-]+/g, '_') ?? '';
  return CLOSED_CODES.has(code) || CLOSED_JOB.test(msg);
}

// How to treat an error from create or confirm. Only an answer from Upwork itself (a tool error) counts as a definite
// refusal; dropped connections, timeouts and 5xx are ambiguous because the proposal may have gone through.
// A retryable UPSTREAM tool error is transient: Upwork did not accept or reject the request.
export function classifyFailure(e: unknown): FailureKind {
  const msg = e instanceof Error ? e.message : String(e);
  if (isAccountWarning(msg)) return 'warning';
  if (/\b429\b|rate.?limit|too many requests|\bthrottled?\b/i.test(msg)) return 'throttle';
  // "Jobs are being opened too quickly" is the same kind of temporary outage as a retryable UPSTREAM lookup.
  // It is checked before the confirmation rule, which also matches the word "permission".
  if (isTransientUpstream(e) || (e instanceof McpToolError && /opened too quickly/i.test(msg))) return 'transient';
  if (/(requires?|needs?|awaiting).{0,40}(user|human|explicit).{0,20}(confirm|approv)|not (allowed|permitted) to confirm|confirmation (is )?required|permission/i.test(msg)) return 'needs_confirmation';
  if (e instanceof McpAuthError) return 'refused';
  if (e instanceof McpToolError && !/timeout|timed out|temporar|try again|\b5\d\d\b|internal error|unavailable/i.test(msg)) return 'refused';
  return 'ambiguous';
}

// Job re-checks after a transient lookup failure. Three calls total, then stop.
// The wait is at least two minutes plus up to a minute of jitter, so a later cron picks it up
// instead of looping inside the request. A rate limit never uses this delay.
// Skip the pre-send find_jobs get when job data was fetched or confirmed inside this window.
export const FRESH_JOB_DETAILS_MS = 60 * 60 * 1000;

export function parseJobTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const ms = Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// True when the newest fetch or confirmation is strictly inside the window. Missing times are not fresh.
export function jobDetailsAreFresh(times: unknown[], now = Date.now()): boolean {
  let latest = Number.NEGATIVE_INFINITY;
  for (const time of times) {
    const ms = parseJobTime(time);
    if (ms !== null && ms > latest) latest = ms;
  }
  return Number.isFinite(latest) && now - latest < FRESH_JOB_DETAILS_MS;
}

export const JOB_LOOKUP_ATTEMPTS = 3;
export const JOB_LOOKUP_BACKOFF_MS = 2 * 60_000;
export const JOB_LOOKUP_JITTER_MS = 60_000;

export function lookupRetryDelayMs(random = Math.random()): number {
  const unit = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
  return JOB_LOOKUP_BACKOFF_MS + Math.floor(unit * JOB_LOOKUP_JITTER_MS);
}

export type ConfirmOutcome = { ok: true; proposalId: string | null } | { ok: false; message: string; uncertain?: boolean };

// confirm_preview answers status "submitted" and data.createJobProposal{status: "SUCCESS", newProposalId, error}.
export function readConfirm(r: unknown): ConfirmOutcome {
  const created = findKey(r, 'createJobProposal') as Record<string, unknown> | undefined;
  const status = String(created?.status ?? findKey(r, 'status') ?? '').toUpperCase();
  const id = created?.newProposalId ?? findKey(r, 'newProposalId') ?? findKey(r, 'proposal_id');
  const error = created?.error ?? findKey(r, 'error');
  if ((status === 'SUCCESS' || status === 'SUBMITTED') && !error) return { ok: true, proposalId: id === undefined || id === null ? null : String(id) };
  const message = typeof error === 'string' ? error : error ? JSON.stringify(error) : `Upwork answered: ${JSON.stringify(r ?? '').slice(0, 200)}`;
  return { ok: false, message: message.slice(0, 300), ...(['ERROR', 'FAILED', 'REFUSED', 'REJECTED'].includes(status) ? {} : { uncertain: true }) };
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
  const recommended = finiteNumber(o.recommended_connects);
  const skip = String(o.recommendation ?? '').toLowerCase() === 'skip';
  // The live API can omit `available` while supplying a recommended auction bid.
  // Absence is not an explicit refusal. A valid positive recommendation establishes
  // availability in that response format; explicit false and skip still take precedence.
  const available = o.available === true || (o.available === undefined && recommended !== null && recommended > 0 && !skip);
  return { available, recommended, max: finiteNumber(o.max_boost_connects), skip };
}

// Recommended boost bid for strong matches in Auto-submit and manually approved Review proposals.
// The bid stays within the per-job maximum, remaining balance and optional Connects floor.
// boostInAuto is the persisted legacy name of the shared boosting switch.
export function boostBid(score: number | null, b: BoostInfo | null, s: Settings, left: number | null): number | null {
  const c = s.caps;
  // A missing score is not a reason to skip. A score that was actually computed still has to clear the threshold.
  if (!c.boostInAuto || (score !== null && score < c.boostMinScore)) return null;
  if (!b || !b.available || b.skip || b.recommended === null) return null;
  const bid = Math.max(1, Math.ceil(b.recommended));
  if (bid > c.boostMaxConnects || (b.max !== null && bid > b.max)) return null;
  if (left !== null && bid > left - (c.connectsFloorEnabled ? c.connectsFloor : 0)) return null;
  return bid;
}

// Explain skipped bids without changing bidding eligibility or spending limits.
export function boostSkipReason(score: number | null, b: BoostInfo | null, s: Settings, left: number | null): string | null {
  const c = s.caps;
  if (!c.boostInAuto) return 'boosting_disabled';
  if (score !== null && score < c.boostMinScore) return 'score_below_minimum';
  if (!b) return 'upwork_boost_metadata_missing';
  if (!b.available) return 'upwork_boost_not_available';
  if (b.skip) return 'upwork_recommends_skip';
  if (b.recommended === null) return 'upwork_recommended_bid_missing';
  const bid = Math.max(1, Math.ceil(b.recommended));
  if (bid > c.boostMaxConnects) return 'bid_above_configured_limit';
  if (b.max !== null && bid > b.max) return 'bid_above_upwork_limit';
  if (left !== null && bid > left - (c.connectsFloorEnabled ? c.connectsFloor : 0)) return 'insufficient_connects_after_application';
  return null;
}

// Upwork re-reads the bids at confirm and refuses (sends nothing) when the boost no longer takes a paid slot.
export const isBoostRefusal = (message: string) => /paid slot|bids? to beat|outbid|boost/i.test(message);

export function finiteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean' || typeof v === 'object') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function boostReasonText(reason: string | null): string | null {
  if (!reason) return null;
  const reasons: Record<string, string> = {
    boosting_disabled: 'Boosting is turned off.',
    missing_score: 'No match score was available.',
    score_below_minimum: 'The score is below your boost threshold.',
    upwork_boost_metadata_missing: 'Upwork did not provide boost information.',
    upwork_boost_not_available: 'Upwork did not mark boosting as available.',
    upwork_recommends_skip: 'Upwork recommended skipping the boost.',
    upwork_recommended_bid_missing: 'Upwork did not provide a recommended boost bid.',
    bid_above_configured_limit: 'The boost bid exceeds your configured limit.',
    bid_above_upwork_limit: 'The boost bid exceeds Upwork’s limit.',
    insufficient_connects_after_application: 'Not enough Connects for the boost within your balance and reserve limits.',
    two_boost_bids_refused: 'Upwork rejected two boost bids.',
    upwork_boost_preview_refused: 'Upwork rejected the boost while preparing the proposal.',
  };
  return reasons[reason] ?? 'A boost bid could not be prepared.';
}
