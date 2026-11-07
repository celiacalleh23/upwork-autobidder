import { setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { environment } from './support/db';
import { receiveApify, drainApify } from '../src/apify';
import { boundPromptDescription } from '../src/claude';
import * as claude from '../src/claude';
import { getKv, putKv } from '../src/kv';
import * as loom from '../src/loom';
import { addJob } from '../src/pipeline/jobs';
import { runWriter } from '../src/pipeline/write';
import { runSender } from '../src/pipeline/send';
import { boundRawPayload, mergeSnapshots, normalizePublicJob, persistSnapshot } from '../src/pipeline/snapshot';
import { DEFAULT_SETTINGS, loadState, patchState, saveSettings, type Env } from '../src/settings';
import { seal } from '../src/crypto';
import * as oauth from '../src/oauth';

async function finishPipeline<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const settled = work.then(value => { done = true; return { value }; }, error => { done = true; return { error }; });
  for (let i = 0; i < 1000 && !done; i++) {
    await realDelay(1);
    if (vi.getTimerCount()) await vi.advanceTimersToNextTimerAsync();
  }
  const result = await settled;
  if ('error' in result) throw result.error;
  return result.value;
}

const dbs: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); dbs.push(e); return e; };
const id = '2115559352186121361';
const zeroId = '0115559352186121361';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); dbs.splice(0).forEach((e) => e.sqlite.close()); });

const rich = (over: Record<string, unknown> = {}) => ({
  id: `02${id}`, url: `https://www.upwork.com/jobs/~02${id}`, title: 'Klaviyo flows for a catalog brand',
  description: 'Build the email flows and campaigns.', date_posted: '2026-11-01T12:00:00Z', created_at: '2026-11-01T12:04:00Z',
  job_type: 'hourly', budget: '40.00–50.00/hr', country: 'unknown', proposal_count: 4, buyer_payment_verified: true,
  questions: [], applied: false, can_apply: true, connects_cost: 12, connects_balance: 80,
  boost: { available: true, recommended_connects: 5 }, currency: 'EUR', ...over,
});

async function ready(e: Env, mode: 'review' | 'auto' = 'review') {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.letter = { template: 'Hi there,\n\nThe fixed letter.', opening: 'off', rules: '' };
  s.loom.sourceUrl = 'https://www.loom.com/share/sourcevideo';
  await saveSettings(e, s);
  await patchState(e, { mode, paused: false, loom: { connected: true } });
}

it('keeps public facts unknown and preserves a leading-zero id as text', () => {
  const snap = normalizePublicJob(zeroId, { ...rich(), id: zeroId, url: `https://www.upwork.com/jobs/~02${zeroId}`, questions: [], country: 'unknown' });
  expect(snap.id).toBe(zeroId);
  expect(snap.id.startsWith('0')).toBe(true);
  expect(snap.applied).toBeNull();
  expect(snap.canApply).toBeNull();
  expect(snap.connectsCost).toBeNull();
  expect(snap.connectsBalance).toBeNull();
  expect(snap.boost).toBeNull();
  expect(snap.currency).toBeNull();
  expect(snap.questions).toBeNull();
  expect(snap.country).toBeNull();
  expect(normalizePublicJob(id, { questions: ['Share two flows'] }).questions).toEqual(['Share two flows']);
  expect(normalizePublicJob(id, { ai_anti_bot_phrase: 'type blue', questions: [] }).questionHint).toBe('type blue');
  const clipped = boundRawPayload({ description: 'x'.repeat(RAW_OVER) });
  expect(clipped.truncated).toBe(true);
  expect(JSON.parse(clipped.json)._truncated).toBe(true);
  expect(boundPromptDescription('y'.repeat(12_001)).note).toMatch(/truncated at 12000/);
});

const RAW_OVER = 100_001;

it('stores the snapshot before receipt cleanup and keeps it across replay', async () => {
  const e = { ...env(), APIFY_WEBHOOK_SECRET: 'synthetic-webhook-secret-at-least-32-characters' };
  const item = rich();
  const body = { items: [item] };
  const res = await receiveApify(new Request('https://local.invalid/api/apify-webhook', {
    method: 'POST', headers: { authorization: `Bearer ${e.APIFY_WEBHOOK_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), e, async () => {});
  expect(res.status).toBe(202);
  await drainApify(e);
  const receipt = JSON.parse(String(e.sqlite.prepare("SELECT value FROM kv WHERE key LIKE 'apify:receipt:%'").get()?.value));
  expect(receipt.status).toBe('done');
  expect(receipt.items).toEqual([]);
  const row = e.sqlite.prepare('SELECT job_id, fetched_at, source_posted_at, source_seen_at, raw_payload, normalized FROM job_snapshots').get() as Record<string, string>;
  expect(row.job_id).toBe(id);
  expect(row.fetched_at).not.toBe(row.source_posted_at);
  expect(row.source_posted_at).toBe('2026-11-01T12:00:00.000Z');
  expect(row.source_seen_at).toBe('2026-11-01T12:04:00.000Z');
  expect(JSON.parse(row.raw_payload).id).toBe(`02${id}`);
  expect(JSON.parse(row.normalized).description).toContain('email flows');
  await drainApify(e);
  expect(e.sqlite.prepare('SELECT count(*) n FROM job_snapshots').get()?.n).toBe(1);
  expect(e.sqlite.prepare('SELECT count(*) n FROM jobs').get()?.n).toBe(1);
});

it('keeps a rich snapshot when an interrupted import is replayed or a partial item arrives', async () => {
  const e = { ...env(), APIFY_WEBHOOK_SECRET: 'synthetic-webhook-secret-at-least-32-characters' };
  for (let i = 0; i < 30; i++) expect((await addJob(e, { jobUrl: String(3115559352186121400n + BigInt(i)) })).ok).toBe(true);
  const blocked = '2115559352186121999';
  const item = { ...rich(), url: `https://www.upwork.com/jobs/~02${blocked}`, description: 'D'.repeat(80), questions: ['How many years?'] };
  await receiveApify(new Request('https://local.invalid/api/apify-webhook', {
    method: 'POST', headers: { authorization: `Bearer ${e.APIFY_WEBHOOK_SECRET}` }, body: JSON.stringify({ items: [item] }),
  }), e, async () => {});
  await drainApify(e);
  const receiptKey = String(e.sqlite.prepare("SELECT key FROM kv WHERE key LIKE 'apify:receipt:%'").get()?.key);
  const receipt = JSON.parse(String(await getKv(e, receiptKey)));
  expect(receipt.status).toBe('error');
  expect(receipt.offset).toBe(0);
  expect(e.sqlite.prepare('SELECT count(*) n FROM jobs WHERE id = ?').get(blocked)?.n).toBe(0);
  expect(JSON.parse(String(e.sqlite.prepare('SELECT normalized FROM job_snapshots WHERE job_id = ?').get(blocked)?.normalized)).description).toHaveLength(80);
  receipt.nextAt = 0;
  await putKv(e, receiptKey, JSON.stringify(receipt));
  await drainApify(e);
  expect(e.sqlite.prepare('SELECT count(*) n FROM job_snapshots WHERE job_id = ?').get(blocked)?.n).toBe(1);
  const full = normalizePublicJob(id, rich({ description: 'FULL DESCRIPTION', questions: ['One real question'] }));
  const thin = normalizePublicJob(id, { title: 'Shorter', questions: [] });
  const merged = mergeSnapshots(full, thin, true);
  expect(merged.description).toBe('FULL DESCRIPTION');
  expect(merged.questions).toEqual(['One real question']);
  await persistSnapshot(e, { jobId: id, source: 'apify', partial: false, raw: rich({ description: 'FULL DESCRIPTION', questions: ['One real question'] }), provenance: { source: 'apify' } });
  await persistSnapshot(e, { jobId: id, source: 'manual', partial: true, raw: { title: 'Only a title' }, provenance: { source: 'manual' } });
  const kept = JSON.parse(String(e.sqlite.prepare('SELECT normalized, fetched_at FROM job_snapshots WHERE job_id = ?').get(id)?.normalized));
  expect(kept.description).toBe('FULL DESCRIPTION');
  expect(kept.questions).toEqual(['One real question']);
});

it('does not change a completed proposal or draft it twice', async () => {
  const e = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic' };
  await ready(e, 'auto');
  await persistSnapshot(e, { jobId: id, source: 'apify', partial: false, raw: rich(), provenance: { source: 'apify' } });
  await addJob(e, { jobUrl: `https://www.upwork.com/jobs/~02${id}`, title: 'Klaviyo flows for a catalog brand', postedAt: '2026-11-01T12:00:00Z', automatic: true });
  const score = vi.spyOn(claude, 'scoreJob').mockResolvedValue({ profileFit: 90, winSimilarity: null, reason: 'Synthetic fit', pros: [], cons: [] });
  const copy = vi.spyOn(loom, 'copyForJob').mockResolvedValue({ id: 'copy1', url: 'https://www.loom.com/share/copy1' });
  const client = vi.spyOn(oauth, 'upworkClient');
  await runWriter(e);
  await runWriter(e);
  expect(client).not.toHaveBeenCalled();
  expect(score).toHaveBeenCalledTimes(1);
  expect(copy).toHaveBeenCalledTimes(1);
  const before = e.sqlite.prepare('SELECT cover_letter, loom_video_id, status, connects FROM proposals').get();
  expect(before).toMatchObject({ status: 'approved', connects: null, loom_video_id: 'copy1' });
  expect(JSON.parse(String(e.sqlite.prepare('SELECT create_params FROM proposals').get()?.create_params)).questions_state).toBe('unknown');
  await persistSnapshot(e, { jobId: id, source: 'apify', partial: false, raw: rich({ description: 'A different later description that must not replace the drafted snapshot' }), provenance: { source: 'apify-replay' } });
  expect(JSON.parse(String(e.sqlite.prepare('SELECT normalized FROM job_snapshots').get()?.normalized)).description).toContain('email flows');
  expect(e.sqlite.prepare('SELECT cover_letter, loom_video_id, status, connects FROM proposals').get()).toEqual(before);
  expect(score).toHaveBeenCalledTimes(1);
  expect((await loadState(e)).lastSendAt).toBeNull();
});

it('drafts with no Upwork client, holds missing data, allows an unknown country, and keeps Review pending', async () => {
  const base = () => ({ ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic' });
  const score = vi.spyOn(claude, 'scoreJob').mockResolvedValue({ profileFit: 90, winSimilarity: null, reason: 'Synthetic fit', pros: [], cons: [] });
  vi.spyOn(loom, 'copyForJob').mockResolvedValue({ id: 'copy1', url: 'https://www.loom.com/share/copy1' });
  const client = vi.spyOn(oauth, 'upworkClient');
  const review = base();
  await ready(review, 'review');
  await persistSnapshot(review, { jobId: id, source: 'apify', partial: false, raw: rich({ country: 'unknown' }), provenance: { source: 'apify' } });
  await addJob(review, { jobUrl: `https://www.upwork.com/jobs/~02${id}`, title: rich().title, postedAt: rich().date_posted, automatic: true });
  await runWriter(review);
  expect(client).not.toHaveBeenCalled();
  expect(review.sqlite.prepare('SELECT status FROM proposals').get()?.status).toBe('pending');
  expect(review.sqlite.prepare('SELECT client_country FROM jobs').get()?.client_country).toBeNull();

  const held = base();
  await ready(held);
  const s = structuredClone(DEFAULT_SETTINGS);
  s.verifiedOnly = true;
  s.letter = { template: 'Hi there,\n\nThe fixed letter.', opening: 'off', rules: '' };
  await saveSettings(held, s);
  const unverified = rich();
  delete unverified.buyer_payment_verified;
  await persistSnapshot(held, { jobId: '2115559352186121362', source: 'apify', partial: false, raw: { ...unverified, url: 'https://www.upwork.com/jobs/~022115559352186121362' }, provenance: { source: 'apify' } });
  await addJob(held, { jobUrl: 'https://www.upwork.com/jobs/~022115559352186121362', title: rich().title, automatic: true });
  const calls = score.mock.calls.length;
  await runWriter(held);
  expect(score).toHaveBeenCalledTimes(calls);
  expect(held.sqlite.prepare('SELECT status, reason FROM jobs').get()).toMatchObject({ status: 'error', reason: expect.stringMatching(/verification/) });
  expect(client).not.toHaveBeenCalled();
});

it('keeps the previous Upwork writer when the flag is off', async () => {
  const e = { ...env(), ANTHROPIC_API_KEY: 'synthetic' };
  await ready(e);
  await patchState(e, { upwork: { connected: true, orgUid: 'mock', toolNames: { find_jobs: 'find_jobs', list_freelancer_proposals: 'list_freelancer_proposals' } } });
  e.sqlite.exec(`INSERT INTO jobs (id, title, url, status, reason) VALUES ('${id}', 'Klaviyo flows', 'https://www.upwork.com/jobs/~02${id}', 'matched', 'Added by link')`);
  const callTool = vi.fn().mockResolvedValue({ invitations: [] });
  const client = vi.spyOn(oauth, 'upworkClient').mockResolvedValue({ callTool } as never);
  await runWriter(e);
  expect(client).toHaveBeenCalled();
});

it('holds a live question mismatch in Review and does not confirm', async () => {
  vi.useFakeTimers();
  const e = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic' };
  await ready(e, 'auto');
  await persistSnapshot(e, { jobId: id, source: 'apify', partial: false, raw: rich({ questions: ['How many years of Klaviyo?'] }), provenance: { source: 'apify' } });
  await addJob(e, { jobUrl: `https://www.upwork.com/jobs/~02${id}`, title: rich().title, postedAt: rich().date_posted, automatic: true });
  vi.spyOn(claude, 'scoreJob').mockResolvedValue({ profileFit: 90, winSimilarity: null, reason: 'Synthetic fit', pros: [], cons: [] });
  vi.spyOn(claude, 'answerQuestions').mockResolvedValue([{ question: 'How many years of Klaviyo?', answer: 'Ten years of Klaviyo work.' }]);
  vi.spyOn(loom, 'copyForJob').mockResolvedValue(null);
  vi.spyOn(oauth, 'upworkClient');
  await runWriter(e);
  expect(JSON.parse(String(e.sqlite.prepare('SELECT create_params FROM proposals').get()?.create_params)).questions_state).toBe('hints');
  await patchState(e, { upwork: { connected: true, orgUid: 'mock', toolNames: {
    find_jobs: 'find_jobs', list_freelancer_proposals: 'list_freelancer_proposals', get_freelancer_dashboard: 'get_freelancer_dashboard',
    manage_proposals: 'manage_proposals', confirm_preview: 'confirm_preview',
  } } });
  await putKv(e, 'upwork_tokens', await seal(e, { accessToken: 'synthetic', expiresAt: Date.now() + 3600_000 }));
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = true; s.caps.activeStart = s.caps.activeEnd = '00:00';
  s.letter = { template: 'Hi there,\n\nThe fixed letter.', opening: 'off', rules: '' };
  await saveSettings(e, s);
  let confirms = 0;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const m = JSON.parse(String(init.body));
    let result: unknown = {};
    if (m.method === 'initialize') result = { protocolVersion: '2025-06-18' };
    if (m.method === 'tools/call') {
      const name = m.params.name;
      let data: unknown = {};
      if (name === 'get_freelancer_dashboard') data = { connectsBalance: 40 };
      if (name === 'find_jobs') data = { connects_cost: 8, connects_balance: 40, can_apply: true, applied: false };
      if (name === 'list_freelancer_proposals') data = { invitations: [] };
      if (name === 'manage_proposals') data = { preview_id: 'synthetic-preview', connects_cost: 8, can_apply: true, questions: ['A different live question'] };
      if (name === 'confirm_preview') confirms++;
      result = { structuredContent: data };
    }
    return new Response(m.id === undefined ? null : JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { status: m.id === undefined ? 202 : 200, headers: { 'content-type': 'application/json' } });
  });
  await finishPipeline(runSender(e));
  expect(confirms).toBe(0);
  expect(e.sqlite.prepare('SELECT status FROM proposals').get()?.status).toBe('pending');
});
