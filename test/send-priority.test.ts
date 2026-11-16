import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { McpError, McpJobAccessError, type McpClient } from '../src/mcp';
import { getKv, putKv } from '../src/kv';
import * as oauth from '../src/oauth';
import { runSender } from '../src/pipeline/send';
import { approvedSendCount, discoveryYieldsToSends } from '../src/pipeline/scan';
import { DEFAULT_SETTINGS, patchState } from '../src/settings';
import { slowDownNote, UpworkBusy } from '../src/upworkPace';
import { environment } from './support/db';

const dbs: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); dbs.push(e); return e; };
const reason = "This job can't be opened right now. It may be private or invite-only, or jobs are being opened too quickly. Slow down and try again later, and don't retry the same job repeatedly.";
const letter = 'I will start with the welcome series for this store.';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); dbs.splice(0).forEach((e) => e.sqlite.close()); });

function settings(over: { sending?: boolean; start?: string; end?: string; tz?: string } = {}) {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = over.sending !== false;
  s.caps.activeStart = over.start ?? '00:00';
  s.caps.activeEnd = over.end ?? '00:00';
  s.caps.timezone = over.tz ?? 'UTC';
  s.caps.boostInAuto = false;
  return s;
}

async function ready(over: { sending?: boolean; start?: string; end?: string; tz?: string } = {}) {
  const e = env();
  await e.DB.prepare("INSERT INTO kv(key,value) VALUES ('settings',?)").bind(JSON.stringify(settings(over))).run();
  await patchState(e, {
    mode: 'review', paused: false,
    upwork: { connected: true, orgUid: 'org', toolNames: {
      find_jobs: 'find_jobs', get_freelancer_dashboard: 'get_freelancer_dashboard', list_freelancer_proposals: 'list_freelancer_proposals',
    } },
  });
  return e;
}

function approve(e: ReturnType<typeof env>, jobId: string, at: string) {
  return e.DB.prepare(
    "INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at) VALUES (?, 'Klaviyo', ?, 30, 'hourly', 'approved', 'dashboard', ?)",
  ).bind(jobId, letter, at).run();
}

const noteOf = async (e: ReturnType<typeof env>) =>
  JSON.parse(String(e.sqlite.prepare("SELECT value FROM kv WHERE key='state'").get()?.value)).senderNote as string;

it('yields discovery only while an approved send can use the Upwork budget', () => {
  const on = { queued: 2, sendingEnabled: true, paused: false, active: true, connected: true };
  expect(discoveryYieldsToSends(on)).toBe(true);
  expect(discoveryYieldsToSends({ ...on, queued: 0 })).toBe(false);
  expect(discoveryYieldsToSends({ ...on, sendingEnabled: false })).toBe(false);
  expect(discoveryYieldsToSends({ ...on, paused: true })).toBe(false);
  expect(discoveryYieldsToSends({ ...on, active: false })).toBe(false);
  expect(discoveryYieldsToSends({ ...on, connected: false })).toBe(false);
});

it('counts sendable approvals and ignores examples and fixed-price rows still waiting on terms', async () => {
  const e = env();
  await approve(e, '2115559352186121361', '2026-11-16 19:27:34');
  await e.DB.prepare(
    "INSERT INTO proposals (job_id, title, cover_letter, job_type, status, is_example) VALUES ('2115559352186121362', 'Example', ?, 'hourly', 'approved', 1)",
  ).bind(letter).run();
  await e.DB.prepare(
    "INSERT INTO proposals (job_id, title, cover_letter, job_type, status) VALUES ('2115559352186121363', 'Fixed', ?, 'fixed', 'approved')",
  ).bind(letter).run();
  expect(await approvedSendCount(e, false)).toBe(1);
  expect(await approvedSendCount(e, true)).toBe(2);
});

it('skips the discovery scan while an approved proposal is waiting, and runs it otherwise', async () => {
  const at = Date.UTC(2026, 10, 16, 20, 30);
  const client = vi.spyOn(oauth, 'upworkClient').mockResolvedValue({ callTool: vi.fn().mockResolvedValue({ jobs: [] }) } as unknown as McpClient);
  const queued = await ready();
  await approve(queued, '2115559352186121361', '2026-11-16 19:27:34');
  await putKv(queued, 'upwork:jobReadRetryAt', String(Date.now() + 5 * 60_000));
  await worker.scheduled({ cron: '* * * * *', scheduledTime: at } as ScheduledController, queued, {} as ExecutionContext);
  expect(client).not.toHaveBeenCalled();

  client.mockClear();
  const idle = await ready();
  await worker.scheduled({ cron: '* * * * *', scheduledTime: at } as ScheduledController, idle, {} as ExecutionContext);
  expect(client).toHaveBeenCalled();

  client.mockClear();
  const outside = await ready({ start: '07:00', end: '21:00', tz: 'America/New_York' });
  await approve(outside, '2115559352186121369', '2026-11-16 19:27:34');
  await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.UTC(2026, 10, 16, 8, 30) } as ScheduledController, outside, {} as ExecutionContext);
  expect(client).toHaveBeenCalled();

  client.mockClear();
  const off = await ready({ sending: false });
  await approve(off, '2115559352186121370', '2026-11-16 19:27:34');
  await worker.scheduled({ cron: '* * * * *', scheduledTime: at } as ScheduledController, off, {} as ExecutionContext);
  expect(client).toHaveBeenCalled();
});

it('waits out a job-open cooldown without an Upwork call or a longer send hold', async () => {
  const e = await ready();
  await approve(e, '2115559352186121361', '2026-11-16 19:27:34');
  const until = Date.now() + 5 * 60_000;
  const previous = String(Date.now() + 60_000);
  await putKv(e, 'upwork:jobReadRetryAt', String(until));
  await putKv(e, 'send:retryAt', previous);
  const client = vi.spyOn(oauth, 'upworkClient');
  await runSender(e);
  expect(client).not.toHaveBeenCalled();
  expect(await getKv(e, 'send:retryAt')).toBe(previous);
  expect(await noteOf(e)).toBe(slowDownNote(until, 'UTC'));
  expect(e.sqlite.prepare('SELECT status FROM proposals').get()).toMatchObject({ status: 'approved' });
});

it('does not extend send:retryAt when the job-open cooldown itself turns the next attempt away', async () => {
  const e = await ready();
  await approve(e, '2115559352186121361', '2026-11-16 19:27:34');
  const previous = String(Date.now() - 1000);
  await putKv(e, 'send:retryAt', previous);
  vi.spyOn(oauth, 'upworkClient').mockResolvedValue({
    callTool: vi.fn().mockRejectedValue(new UpworkBusy('Job-detail reads are cooling down after an Upwork access refusal.')),
  } as unknown as McpClient);
  await runSender(e);
  expect(await getKv(e, 'send:retryAt')).toBe(previous);
  expect(await noteOf(e)).toBe('Upwork asked to slow down; sending again next round.');
  expect(e.sqlite.prepare('SELECT status FROM proposals').get()).toMatchObject({ status: 'approved' });
});

it('honours an Upwork 429 with its own retry time and does not add the 5-minute send hold', async () => {
  const e = await ready();
  await approve(e, '2115559352186121361', '2026-11-16 19:27:34');
  const start = Date.now();
  vi.spyOn(oauth, 'upworkClient').mockResolvedValue({
    callTool: vi.fn().mockRejectedValue(new McpError('Upwork MCP tools/call failed (429) retry_after: 5: slow down')),
  } as unknown as McpClient);
  await runSender(e);
  expect(await getKv(e, 'send:retryAt')).toBeNull();
  const until = Number(await getKv(e, 'upwork:retryAt'));
  expect(until).toBeGreaterThanOrEqual(start + 6_000);
  expect(until).toBeLessThan(start + 8_000);
  expect(await noteOf(e)).toBe(slowDownNote(until, 'UTC'));
});

it('keeps the refused job behind the other approvals and still holds a non-Upwork error for 5 minutes', async () => {
  const older = '2115559352186121361';
  const newer = '2115559352186121362';
  const e = await ready();
  await approve(e, older, '2026-11-16 19:27:34');
  await approve(e, newer, '2026-11-16 19:28:04');
  const gets: string[] = [];
  const callTool = vi.fn(async (_name: string, args: { action?: string; params?: { id?: string } }) => {
    if (args?.action === 'check') return { connectsBalance: 50 };
    if (args?.action === 'get') {
      gets.push(String(args.params?.id));
      throw new McpJobAccessError(reason, { jobId: String(args.params?.id), orgUid: 'org', reason, traceId: 'trace' });
    }
    return { invitations: [] };
  });
  vi.spyOn(oauth, 'upworkClient').mockResolvedValue({ callTool } as unknown as McpClient);
  await runSender(e);
  expect(gets).toEqual([older]);
  expect(await getKv(e, 'send:retryAt')).toBeNull();
  const until = Number(await getKv(e, 'upwork:jobReadRetryAt'));
  expect(until).toBeGreaterThan(Date.now());
  expect(await noteOf(e)).toBe(slowDownNote(until, 'UTC'));
  expect(e.sqlite.prepare('SELECT status FROM proposals ORDER BY approved_at').all().map((r) => r.status)).toEqual(['approved', 'approved']);

  await putKv(e, 'upwork:jobReadRetryAt', String(Date.now() - 1));
  await runSender(e);
  expect(gets).toEqual([older, newer]);
  expect(await getKv(e, 'send:retryAt')).toBeNull();

  callTool.mockRejectedValueOnce(new Error('socket hang up'));
  await putKv(e, 'upwork:jobReadRetryAt', String(Date.now() - 1));
  const start = Date.now();
  await runSender(e);
  const held = Number(await getKv(e, 'send:retryAt'));
  expect(held).toBeGreaterThan(start + 4 * 60_000);
  expect(held).toBeLessThan(start + 5 * 60_000);
});
