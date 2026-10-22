import { describe, expect, it } from 'vitest';
import { McpAuthError, McpError, McpToolError } from '../src/mcp';
import { alertAction, classifyFailure, connectsGate, readConfirm, sendGate } from '../src/pipeline/sendRules';
import { DEFAULT_SETTINGS, DEFAULT_STATE, type Settings, type State } from '../src/settings';

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
  it('keeps proposals 5 minutes apart, with slack for the cron', () => {
    expect(sendGate(st({ lastSendAt: '2026-10-23T17:57:00Z' }), s(), none, now)).toBe('Next proposal in 2 min (5 min apart).');
    expect(sendGate(st({ lastSendAt: '2026-10-23T17:55:20Z' }), s(), none, now)).toBeNull(); // 4m40s ago
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
  it('spots rate limits and requests for a human confirmation', () => {
    expect(classifyFailure(new McpToolError('Upwork confirm_preview: 429 Too Many Requests'))).toBe('rate_limit');
    expect(classifyFailure(new McpToolError('Upwork confirm_preview: This action requires explicit user confirmation in the Upwork app'))).toBe('needs_confirmation');
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
