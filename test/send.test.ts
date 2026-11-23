import { describe, expect, it } from 'vitest';
import { isAccountWarning, McpAuthError, McpError, McpToolError, throttleWait } from '../src/mcp';
import { alertAction, classifyFailure, connectsGate, FRESH_JOB_DETAILS_MS, isJobClosedOrMissing, jobDetailsAreFresh, lookupRetryDelayMs, readConfirm, sendGate } from '../src/pipeline/sendRules';
import { DEFAULT_SETTINGS, DEFAULT_STATE, validateSettings, type Settings, type State } from '../src/settings';

// Siv's settings (BUILD_PLAN §11a): 24/7, no caps, 5 min apart, no floor, sending switched on.
const s = (over: Partial<Settings> = {}, caps: Partial<Settings['caps']> = {}): Settings => {
  const base = structuredClone(DEFAULT_SETTINGS);
  return { ...base, sendingEnabled: true, ...over, caps: { ...base.caps, activeStart: '00:00', activeEnd: '00:00', daily: 0, hourly: 0, gapMinutes: 5, ...caps } };
};
const st = (over: Partial<State> = {}): State => ({ ...structuredClone(DEFAULT_STATE), upwork: { ...DEFAULT_STATE.upwork, connected: true }, ...over });
const none = { sentToday: 0, sentLastHour: 0 };
const now = new Date('2026-10-23T18:00:00Z');

describe('sendGate', () => {
  it('lets a send through with Siv\'s settings', () => {
    expect(sendGate(st(), s(), none, now)).toBeNull();
  });
  it('does nothing while sending is off, paused or disconnected', () => {
    expect(sendGate(st(), s({ sendingEnabled: false }), none, now)).toBe('Sending is off (Settings → Sending).');
    expect(sendGate(st({ paused: true, pausedReason: 'Upwork rate limit' }), s(), none, now)).toBe('Paused: Upwork rate limit');
    expect(sendGate(st({ upwork: { ...DEFAULT_STATE.upwork, connected: false } }), s(), none, now)).toBe('Upwork is not connected.');
  });
  it('does not hold a manual approval for the gap, and still applies the daily cap', () => {
    const recent = st({ lastSendAt: '2026-10-23T17:59:00Z' });
    expect(sendGate(recent, s(), none, now)).toContain('Next proposal');
    expect(sendGate(recent, s(), none, now, true)).toBeNull();
    expect(sendGate(recent, s({}, { daily: 1 }), { sentToday: 1, sentLastHour: 0 }, now, true)).toBe('Daily cap reached (1).');
  });
  it('keeps proposals at least 5 minutes apart', () => {
    expect(sendGate(st({ lastSendAt: '2026-10-23T17:57:00Z' }), s(), none, now)).toBe('Next proposal in 2 min (5 min apart).');
    expect(sendGate(st({ lastSendAt: '2026-10-23T17:55:20Z' }), s(), none, now)).toContain('Next proposal');
    expect(sendGate(st({ lastSendAt: '2026-10-23T17:55:00Z' }), s(), none, now)).toBeNull();
  });
  it('applies caps and active hours only when set', () => {
    expect(sendGate(st(), s({}, { daily: 15 }), { sentToday: 15, sentLastHour: 0 }, now)).toBe('Daily cap reached (15).');
    expect(sendGate(st(), s({}, { hourly: 3 }), { sentToday: 3, sentLastHour: 3 }, now)).toBe('Hourly cap reached (3).');
    expect(sendGate(st(), s(), { sentToday: 500, sentLastHour: 60 }, now)).toBeNull();
    // 11:00 in Los Angeles is outside 07:00–09:00
    expect(sendGate(st(), s({}, { activeStart: '07:00', activeEnd: '09:00', timezone: 'America/Los_Angeles' }), none, now)).toBe('Outside active hours (07:00–09:00).');
  });
});

describe('connectsGate', () => {
  it('waits when the balance cannot pay for the job', () => {
    expect(connectsGate(10, 12, s())).toBe('Waiting for Connects: balance 10, this job costs 12.');
    expect(connectsGate(12, 12, s())).toBeNull();
    expect(connectsGate(null, 12, s())).toBe('Could not read the Connects balance.');
  });
  it('applies the floor only when switched on', () => {
    expect(connectsGate(30, 12, s({}, { connectsFloorEnabled: true, connectsFloor: 20 }))).toBe('Connects floor: sending would leave 18, below 20.');
    expect(connectsGate(30, 12, s({}, { connectsFloorEnabled: false, connectsFloor: 20 }))).toBeNull();
  });
});

describe('classifyFailure', () => {
  it('treats an answer from Upwork as a definite refusal', () => {
    expect(classifyFailure(new McpToolError('Upwork confirm_preview: You have already submitted a proposal to this job'))).toBe('refused');
    expect(classifyFailure(new McpAuthError('Upwork refused the sign-in (401)'))).toBe('refused');
  });
  it('treats timeouts, dropped connections and 5xx as ambiguous (maybe sent)', () => {
    expect(classifyFailure(new McpError('Upwork MCP tools/call failed (502): bad gateway'))).toBe('ambiguous');
    expect(classifyFailure(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe('ambiguous');
    expect(classifyFailure(new McpToolError('Upwork confirm_preview: upstream timeout, try again'))).toBe('ambiguous');
  });
  it('tells Upwork\'s per-minute limit from an account warning, and spots requests for a human confirmation', () => {
    expect(classifyFailure(new McpToolError('Upwork confirm_preview: 429 Too Many Requests'))).toBe('throttle');
    expect(classifyFailure(new McpToolError('Upwork find_jobs: {"error_code":"SENSITIVE_RATE_LIMIT_EXCEEDED","reason":"Rate limit exceeded for this tool. Wait about 5 seconds before retrying"}'))).toBe('throttle');
    expect(classifyFailure(new McpToolError('Upwork manage_proposals: Your account is restricted after unusual activity'))).toBe('warning');
    expect(classifyFailure(new McpToolError('Upwork find_jobs: rate limit: account warning issued'))).toBe('warning');
    // Oct 30, on Rafa's account:
    const restricted = 'Upwork find_jobs: {"error_code":"CLIENT","reason":"Your access to search has been restricted due to violations of our Terms of Service. Please contact support if you believe this is an error. This restriction applies to this account\'s search surface. Changing search parameters or immediately retrying will not help."}';
    expect(classifyFailure(new McpToolError(restricted))).toBe('warning');
    expect(isAccountWarning(restricted)).toBe(true);
    expect(throttleWait(new McpToolError(restricted))).toBeNull(); // never waited out and retried
    expect(isAccountWarning('Upwork find_jobs: {"error_code":"SENSITIVE_RATE_LIMIT_EXCEEDED","reason":"Rate limit exceeded for this tool. Wait about 5 seconds before retrying"}')).toBe(false);
    expect(isAccountWarning('Upwork manage_proposals: This job is no longer accepting proposals')).toBe(false);
    expect(classifyFailure(new McpToolError('Upwork confirm_preview: This action requires explicit user confirmation in the Upwork app'))).toBe('needs_confirmation');
  });
  it('treats a retryable UPSTREAM lookup as transient, and a closed job as a refusal', () => {
    const payload = '{"error_code":"UPSTREAM","reason":"upstream service error","retryable":true,"trace_id":"abc"}';
    const upstream = new McpToolError(`Upwork find_jobs: ${payload}`);
    expect(classifyFailure(upstream)).toBe('transient');
    expect(isJobClosedOrMissing(upstream)).toBe(false);
    const truncated = `Upwork find_jobs: ${`${payload.slice(0, -1)},"extra":"${'x'.repeat(400)}"}`.slice(0, 300)}`;
    expect(classifyFailure(new McpToolError(truncated))).toBe('transient');
    expect(classifyFailure(new McpToolError('Upwork find_jobs: upstream service error'))).toBe('transient');
    const throttled = new McpToolError('Upwork find_jobs: {"error_code":"THROTTLED","reason":"Slow down","retryable":true}');
    expect(classifyFailure(throttled)).toBe('throttle');
    expect(throttleWait(throttled)).toBe(11_000);
    const missing = new McpToolError('Upwork find_jobs: {"error_code":"NOT_FOUND","reason":"Job not found","retryable":false}');
    expect(classifyFailure(missing)).toBe('refused');
    expect(isJobClosedOrMissing(missing)).toBe(true);
    expect(isJobClosedOrMissing(new McpToolError('Upwork find_jobs: This job is no longer available'))).toBe(true);
    const gone = new McpToolError('Upwork manage_proposals: {"error_code":"JOB_IS_NO_LONGER_AVAILABLE","reason":"This job is no longer available","retryable":false}');
    expect(classifyFailure(gone)).toBe('refused');
    expect(isJobClosedOrMissing(gone)).toBe(true);
    expect(classifyFailure(new McpToolError('Upwork find_jobs: jobs are being opened too quickly'))).toBe('transient');
    expect(classifyFailure(new McpToolError('Upwork find_jobs: {"error_code":"PERMISSION","reason":"Jobs are being opened too quickly. Slow down."}'))).toBe('transient');
  });
});

describe('fresh job details', () => {
  const now = Date.parse('2026-11-23T18:00:00Z');
  it('treats a read inside the hour as fresh and an older one as stale', () => {
    expect(FRESH_JOB_DETAILS_MS).toBe(60 * 60 * 1000);
    expect(jobDetailsAreFresh([new Date(now - 59 * 60_000).toISOString()], now)).toBe(true);
    expect(jobDetailsAreFresh(['2026-11-23 17:30:00'], now)).toBe(true);
    expect(jobDetailsAreFresh([new Date(now - FRESH_JOB_DETAILS_MS).toISOString()], now)).toBe(false);
    expect(jobDetailsAreFresh([new Date(now - 2 * FRESH_JOB_DETAILS_MS).toISOString()], now)).toBe(false);
    expect(jobDetailsAreFresh([null, ''], now)).toBe(false);
    expect(jobDetailsAreFresh([new Date(now - 2 * FRESH_JOB_DETAILS_MS).toISOString(), new Date(now - 5 * 60_000).toISOString()], now)).toBe(true);
  });
});

describe('lookup retry spacing', () => {
  it('waits at least two minutes and adds jitter, and does not collapse to a tight loop', () => {
    expect(lookupRetryDelayMs(0)).toBe(2 * 60_000);
    expect(lookupRetryDelayMs(1)).toBe(3 * 60_000);
    expect(lookupRetryDelayMs(0.25)).toBeGreaterThan(lookupRetryDelayMs(0));
    expect(lookupRetryDelayMs(0.25)).toBeLessThan(lookupRetryDelayMs(1));
  });
});

describe('readConfirm', () => {
  it('reads the success shape seen on Oct 15', () => {
    expect(readConfirm({ status: 'submitted', data: { createJobProposal: { status: 'SUCCESS', newProposalId: '1844', error: null } } })).toEqual({ ok: true, proposalId: '1844' });
  });
  it('reports Upwork errors', () => {
    expect(readConfirm({ data: { createJobProposal: { status: 'ERROR', error: 'Job is closed' } } })).toEqual({ ok: false, message: 'Job is closed' });
    expect(readConfirm({ something: 'else' })).toMatchObject({ ok: false });
  });
});

describe('alertAction', () => {
  it('sends once per drop below 250 and re-arms when the balance is back up', () => {
    expect(alertAction(240, 250, null)).toBe('send');
    expect(alertAction(200, 250, '2026-10-23T10:00:00Z')).toBeNull();
    expect(alertAction(300, 250, '2026-10-23T10:00:00Z')).toBe('reset');
    expect(alertAction(300, 250, null)).toBeNull();
    expect(alertAction(10, 0, null)).toBeNull(); // alert off
  });
});


describe('minimum sending gap setting', () => {
  it('accepts three minutes and preserves higher configured gaps', () => {
    expect(validateSettings(s({}, { gapMinutes: 3 })).caps.gapMinutes).toBe(3);
    expect(validateSettings(s({}, { gapMinutes: 10 })).caps.gapMinutes).toBe(10);
    expect(() => validateSettings(s({}, { gapMinutes: 2 }))).toThrow('Minimum gap');
    expect(() => validateSettings(s({}, { gapMinutes: 121 }))).toThrow('Minimum gap');
  });
});
