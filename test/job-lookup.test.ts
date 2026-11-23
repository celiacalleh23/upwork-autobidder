import { setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { seal } from '../src/crypto';
import { getKv, putKv } from '../src/kv';
import { McpToolError, type McpClient } from '../src/mcp';
import * as oauth from '../src/oauth';
import { runSender } from '../src/pipeline/send';
import { FRESH_JOB_DETAILS_MS } from '../src/pipeline/sendRules';
import { DEFAULT_SETTINGS, loadState, patchState } from '../src/settings';
import { environment } from './support/db';

const dbs: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); dbs.push(e); return e; };
const letter = 'Hi there, the letter is ready for this Klaviyo job.';
const upstreamText = 'Upwork find_jobs: {"error_code":"UPSTREAM","reason":"upstream service error","retryable":true,"trace_id":"t-1"}';
const goneText = 'Upwork manage_proposals: {"error_code":"JOB_IS_NO_LONGER_AVAILABLE","reason":"This job is no longer available","retryable":false}';
const throttledText = 'Upwork find_jobs: {"error_code":"THROTTLED","reason":"Slow down","retryable":true}';
const exhausted = "Couldn't re-check the job on Upwork (temporary lookup error). Approve again to retry.";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); dbs.splice(0).forEach((e) => e.sqlite.close()); });

function settings() {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = true;
  s.caps.activeStart = '00:00';
  s.caps.activeEnd = '00:00';
  s.caps.timezone = 'UTC';
  s.caps.boostInAuto = false;
  return s;
}

async function ready() {
  const e = env();
  await e.DB.prepare("INSERT INTO kv(key,value) VALUES ('settings',?)").bind(JSON.stringify(settings())).run();
  await patchState(e, {
    mode: 'review', paused: false,
    upwork: { connected: true, orgUid: 'org', toolNames: {
      find_jobs: 'find_jobs', get_freelancer_dashboard: 'get_freelancer_dashboard',
      list_freelancer_proposals: 'list_freelancer_proposals', manage_proposals: 'manage_proposals', confirm_preview: 'confirm_preview',
    } },
  });
  return e;
}

function approve(e: ReturnType<typeof env>, detailsAt: string | null) {
  const params = detailsAt ? JSON.stringify({ details_at: detailsAt }) : '{}';
  return e.DB.prepare(
    "INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, create_params) VALUES ('2115559352186121361', 'Klaviyo', ?, 30, 'hourly', 'approved', 'dashboard', ?, ?)",
  ).bind(letter, '2026-11-23 18:00:00', params).run();
}

const rowOf = (e: ReturnType<typeof env>) =>
  e.sqlite.prepare('SELECT status, error FROM proposals').get() as { status: string; error: string | null };

const markOf = async (e: ReturnType<typeof env>) => {
  const raw = await getKv(e, 'send:jobLookup:1');
  return raw ? JSON.parse(raw) as { n: number; nextAt: number } : null;
};

function client(callTool: McpClient['callTool']) {
  vi.spyOn(oauth, 'upworkClient').mockResolvedValue({ callTool } as unknown as McpClient);
}

async function finish<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const settled = work.then((value) => { done = true; return { value }; }, (error) => { done = true; return { error }; });
  for (let i = 0; i < 1000 && !done; i++) {
    await realDelay(1);
    if (vi.getTimerCount()) await vi.advanceTimersToNextTimerAsync();
  }
  expect(done, 'sender must settle while its clock is driven').toBe(true);
  const result = await settled;
  if ('error' in result) throw result.error;
  return result.value;
}

it('skips the job re-check when details were fetched within the last hour and sends', async () => {
  const e = await ready();
  await approve(e, new Date().toISOString());
  const actions: string[] = [];
  client(async (name, args: { action?: string }) => {
    actions.push(`${name}:${args?.action}`);
    if (args?.action === 'get') throw new Error('fresh details must not be re-checked');
    if (args?.action === 'check') return { connectsBalance: 80 };
    if (args?.action === 'invitations') return { invitations: [] };
    if (args?.action === 'create') return { preview_id: 'preview-1', connects_cost: 8, can_apply: true, questions: [] };
    if (args?.action === 'confirm') return { status: 'submitted', data: { createJobProposal: { status: 'SUCCESS', newProposalId: '99', error: null } } };
    return {};
  });
  await runSender(e);
  expect(actions).not.toContain('find_jobs:get');
  expect(actions).toContain('manage_proposals:create');
  expect(actions).toContain('confirm_preview:confirm');
  expect(rowOf(e)).toMatchObject({ status: 'submitted', error: null });
  expect((await loadState(e)).mode).toBe('review');
});

it('re-checks a stale job and keeps the proposal approved on a transient upstream error', async () => {
  const e = await ready();
  await approve(e, new Date(Date.now() - 2 * FRESH_JOB_DETAILS_MS).toISOString());
  let gets = 0;
  client(async (_name, args: { action?: string }) => {
    if (args?.action === 'check') return { connectsBalance: 80 };
    if (args?.action === 'get') { gets += 1; throw new McpToolError(upstreamText); }
    return { invitations: [] };
  });
  const start = Date.now();
  await runSender(e);
  expect(gets).toBe(1);
  expect(rowOf(e)).toEqual({ status: 'approved', error: null });
  expect(rowOf(e).error ?? '').not.toContain('no longer available');
  const mark = await markOf(e);
  expect(mark?.n).toBe(1);
  expect(mark!.nextAt).toBeGreaterThanOrEqual(start + 2 * 60_000);
  expect(mark!.nextAt).toBeLessThan(start + 3 * 60_000 + 50);
  expect(await getKv(e, 'send:retryAt')).toBeNull();
  await runSender(e);
  expect(gets).toBe(1);

  const paced = JSON.parse((await getKv(e, 'send:jobLookup:1'))!);
  paced.nextAt = Date.now() - 1;
  await putKv(e, 'upwork:retryAt', String(Date.now() + 10 * 60_000));
  await putKv(e, 'send:jobLookup:1', JSON.stringify(paced));
  await runSender(e);
  expect(gets).toBe(1);
  expect((await markOf(e))?.n).toBe(1);
});

it('stops after three spaced re-checks and asks for a new approval', async () => {
  const e = await ready();
  await approve(e, new Date(Date.now() - 2 * FRESH_JOB_DETAILS_MS).toISOString());
  let gets = 0;
  client(async (_name, args: { action?: string }) => {
    if (args?.action === 'check') return { connectsBalance: 80 };
    if (args?.action === 'get') { gets += 1; throw new McpToolError(upstreamText); }
    return { invitations: [] };
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      const mark = await markOf(e);
      await putKv(e, 'send:jobLookup:1', JSON.stringify({ n: mark!.n, nextAt: Date.now() - 1 }));
    }
    await runSender(e);
    expect(gets).toBe(attempt);
  }
  expect(rowOf(e)).toEqual({ status: 'failed', error: exhausted });
  expect(await getKv(e, 'send:jobLookup:1')).toBeNull();
  await runSender(e);
  expect(gets).toBe(3);
  expect((await loadState(e)).mode).toBe('review');
});

it('does not retry a rate limit ahead of Upwork’s own clock', async () => {
  const e = await ready();
  await approve(e, new Date(Date.now() - 2 * FRESH_JOB_DETAILS_MS).toISOString());
  let gets = 0;
  const upwork = vi.spyOn(oauth, 'upworkClient').mockResolvedValue({
    callTool: async (_name: string, args: { action?: string }) => {
      if (args?.action === 'check') return { connectsBalance: 80 };
      if (args?.action === 'get') { gets += 1; throw new McpToolError(throttledText); }
      return { invitations: [] };
    },
  } as unknown as McpClient);
  const start = Date.now();
  await runSender(e);
  expect(gets).toBe(1);
  expect(rowOf(e)).toEqual({ status: 'approved', error: null });
  expect(await getKv(e, 'send:jobLookup:1')).toBeNull();
  expect(await getKv(e, 'send:retryAt')).toBeNull();
  const until = Number(await getKv(e, 'upwork:retryAt'));
  expect(until).toBeGreaterThanOrEqual(start + 11_000);
  expect(until).toBeLessThan(start + 13_000);
  await runSender(e);
  expect(gets).toBe(1);
  expect(upwork).toHaveBeenCalledTimes(1);
});

it('marks a fresh send closed when Upwork says the job is gone, and does not retry', async () => {
  const e = await ready();
  await approve(e, new Date().toISOString());
  const actions: string[] = [];
  client(async (name, args: { action?: string }) => {
    actions.push(`${name}:${args?.action}`);
    if (args?.action === 'get') throw new Error('fresh details must not be re-checked');
    if (args?.action === 'check') return { connectsBalance: 80 };
    if (args?.action === 'invitations') return { invitations: [] };
    if (args?.action === 'create') throw new McpToolError(goneText);
    return {};
  });
  await runSender(e);
  expect(actions).not.toContain('find_jobs:get');
  expect(rowOf(e).status).toBe('failed');
  expect(rowOf(e).error).toContain('Upwork refused the proposal');
  expect(rowOf(e).error).toContain('JOB_IS_NO_LONGER_AVAILABLE');
  expect(rowOf(e).error).not.toContain(exhausted);
  expect(await getKv(e, 'send:jobLookup:1')).toBeNull();
  await runSender(e);
  expect(actions.filter((action) => action === 'manage_proposals:create')).toHaveLength(1);
});

it('counts a later re-check against the Upwork call budget and does not call while that budget is closed', async () => {
  vi.useFakeTimers();
  const e = await ready();
  await putKv(e, 'upwork_tokens', await seal(e, { accessToken: 'synthetic', expiresAt: Date.now() + 3_600_000 }));
  await approve(e, new Date(Date.now() - 2 * FRESH_JOB_DETAILS_MS).toISOString());
  let gets = 0;
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string; params?: { name?: string; arguments?: { action?: string } } };
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown = {};
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18' };
    if (message.method === 'tools/call') {
      const action = message.params?.arguments?.action;
      if (message.params?.name === 'find_jobs' && action === 'get') {
        gets += 1;
        result = { isError: true, content: [{ type: 'text', text: upstreamText.replace('Upwork find_jobs: ', '') }] };
      } else result = { structuredContent: action === 'check' ? { connectsBalance: 80 } : { invitations: [] } };
    }
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  });
  await finish(runSender(e));
  expect(gets).toBe(1);
  expect(await getKv(e, 'upwork:slowSlot')).toBeTruthy();
  const mark = await markOf(e);
  await putKv(e, 'send:jobLookup:1', JSON.stringify({ n: mark!.n, nextAt: Date.now() - 1 }));
  await putKv(e, 'upwork:slowSlot', String(Date.now() + 120_000));
  await finish(runSender(e));
  expect(gets).toBe(1);
  expect(rowOf(e)).toEqual({ status: 'approved', error: null });
  expect((await markOf(e))?.n).toBe(1);
});
