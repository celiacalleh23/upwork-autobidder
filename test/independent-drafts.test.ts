import { setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { environment } from './support/db';
import { receiveApify, drainApify } from '../src/apify';
import { boundPromptDescription } from '../src/claude';
import * as claude from '../src/claude';
import { getKv, putKv } from '../src/kv';
import * as loom from '../src/loom';
import { addJob } from '../src/pipeline/jobs';
import { draftReadyKey, runWriter } from '../src/pipeline/write';
import { runSender } from '../src/pipeline/send';
import { computeBid } from '../src/pipeline/letter';
import { boundRawPayload, draftBid, mergeSnapshots, normalizePublicJob, persistSnapshot, snapshotHoldReason, submissionBlock, submissionGaps, unverifiedPriceHold } from '../src/pipeline/snapshot';
import { metaLanguageIn, openingFromTitle } from '../src/pipeline/letter';
import { DEFAULT_SETTINGS, DEFAULT_STATE, loadState, patchState, saveSettings, type Env } from '../src/settings';
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
  expect(normalizePublicJob(id, { description: 'Line one\n\nLine two' }).description).toBe('Line one\n\nLine two');
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
  await ready(held, 'auto');
  const s = structuredClone(DEFAULT_SETTINGS);
  s.verifiedOnly = true;
  s.letter = { template: 'Hi there,\n\nThe fixed letter.', opening: 'off', rules: '' };
  s.sendingEnabled = true;
  s.caps.activeStart = s.caps.activeEnd = '00:00';
  await saveSettings(held, s);
  const unverified = rich();
  delete unverified.buyer_payment_verified;
  await persistSnapshot(held, { jobId: '2115559352186121362', source: 'apify', partial: false, raw: { ...unverified, url: 'https://www.upwork.com/jobs/~022115559352186121362' }, provenance: { source: 'apify' } });
  await addJob(held, { jobUrl: 'https://www.upwork.com/jobs/~022115559352186121362', title: rich().title, automatic: true });
  await runWriter(held);
  expect(client).not.toHaveBeenCalled();
  const drafted = held.sqlite.prepare('SELECT status, approved_via, bid, error FROM proposals').get() as { status: string; approved_via: string | null; bid: number; error: string };
  expect(drafted).toMatchObject({ status: 'approved', approved_via: 'auto-submit', bid: 50 });
  expect(drafted.error).toMatch(/client payment verification/);
  expect(held.sqlite.prepare('SELECT budget FROM proposals').get()?.budget).toBe('40.00–50.00/hr');
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
  expect(e.sqlite.prepare('SELECT status, approved_at, approved_via FROM proposals').get()).toMatchObject({ status: 'pending', approved_at: null, approved_via: null });
  await finishPipeline(runSender(e));
  expect(confirms).toBe(0);
  expect(e.sqlite.prepare('SELECT status, approved_via FROM proposals').get()).toMatchObject({ status: 'pending', approved_via: null });
});

const heldJobId = '2118988132749471492';
const fixedPricePayload = () => ({
  id: `02${heldJobId}`, url: `https://www.upwork.com/jobs/~02${heldJobId}`,
  title: 'Klaviyo Email Designer Needed for Fashion Shopify Store',
  description: 'Design the Klaviyo emails for the store.',
  price_type: 'Fixed-price', price: 5, buyer_payment_verified: true, proposal_count: 4,
});

const hyperbach = 'hyperbach-public-upwork' as const;

it('lists a Hyperbach fixed price of 5 as Upwork USD and keeps every other price unresolved', () => {
  const snap = normalizePublicJob(heldJobId, fixedPricePayload(), hyperbach);
  expect(snap.jobType).toBe('fixed');
  expect(snap.budgetText).toBe('5.00');
  expect(snap.amountSource).toBe('price');
  expect(snap.listedCurrency).toBe('USD');
  expect(snap.explicitCurrency).toBeNull();
  expect(snap.currency).toBeNull();
  expect(snap.budgetFault).toBeNull();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.bid = { hourly: 'profile', fixed: 'client_budget', profileRate: 30 };
  settings.minFixedBudget = 20;
  expect(computeBid(snap.jobType, snap.budgetText, settings)).toBe(5);
  expect(snapshotHoldReason(snap, settings)).toBeNull();
  expect(computeBid('fixed', null, settings)).toBeNull();
  expect(computeBid('hourly', null, settings)).toBe(30);
  for (const price of [0, '0', '0.00', '>=5', '5-10', 'abc']) {
    const bad = normalizePublicJob(heldJobId, { ...fixedPricePayload(), price }, hyperbach);
    expect(bad.listedCurrency).toBeNull();
    expect(bad.budgetFault).toBe('malformed');
    expect(snapshotHoldReason(bad, settings)).toMatch(/zero or not a single positive amount/);
  }
  const blankPrice = normalizePublicJob(heldJobId, { ...fixedPricePayload(), price: '' }, hyperbach);
  expect(blankPrice.budgetFault).toBeNull();
  expect(blankPrice.budgetText).toBeNull();
  expect(snapshotHoldReason(blankPrice, settings)).toBeNull();
  expect(submissionGaps(blankPrice, settings)).toContain('client-fixed-amount-missing');
  expect(draftBid(blankPrice, settings).amount).toBeNull();
  for (const price of ['5', '5.00', 5]) {
    expect(normalizePublicJob(heldJobId, { ...fixedPricePayload(), price }, hyperbach).budgetText).toBe('5.00');
  }
  const unnamed = normalizePublicJob(heldJobId, fixedPricePayload());
  expect(unnamed.listedCurrency).toBeNull();
  expect(unnamed.budgetText).toBe('5.00');
  expect(snapshotHoldReason(unnamed, settings)).toBeNull();
  expect(unverifiedPriceHold(unnamed, settings)).toBeNull();
  expect(submissionGaps(unnamed, settings)).toContain('currency-undocumented');
  expect(draftBid(unnamed, settings)).toEqual({ amount: 5, basis: 'client' });
  const conflict = normalizePublicJob(heldJobId, { ...fixedPricePayload(), currency: 'EUR' }, hyperbach);
  expect(conflict.listedCurrency).toBeNull();
  expect(conflict.explicitCurrency).toBe('EUR');
  expect(snapshotHoldReason(conflict, settings)).toMatch(/not replaced with USD/);
  const named = normalizePublicJob(heldJobId, { ...fixedPricePayload(), currency: 'usd' }, hyperbach);
  expect(named.explicitCurrency).toBe('USD');
  expect(named.listedCurrency).toBeNull();
  expect(snapshotHoldReason(named, settings)).toBeNull();
  const hourly = normalizePublicJob(id, { price_type: 'Hourly', price_min: '10', price_max: 35 }, hyperbach);
  expect(hourly.budgetText).toBe('10.00–35.00/hr');
  expect(hourly.amountSource).toBe('hourly-band');
  expect(hourly.listedCurrency).toBe('USD');
  expect(normalizePublicJob(id, { price_type: 'Hourly', price: 25, budget: '40.00–50.00/hr' }).budgetText).toBe('40.00–50.00/hr');
});

it('filters the public $5 fixed-price job at the live minimum of 20 and does not requeue it', async () => {
  const e = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic', APIFY_PROVIDER: 'hyperbach' as const };
  await ready(e, 'auto');
  const s = structuredClone(DEFAULT_SETTINGS);
  s.bid = { hourly: 'profile', fixed: 'client_budget', profileRate: 30 };
  s.minFixedBudget = 20;
  s.fixedPriceTermsAcknowledged = true;
  s.letter = { template: 'Hi there,\n\nThe fixed letter.', opening: 'off', rules: '' };
  s.sendingEnabled = true;
  s.caps.activeStart = s.caps.activeEnd = '00:00';
  await saveSettings(e, s);
  await persistSnapshot(e, { jobId: heldJobId, source: 'apify', partial: false, raw: fixedPricePayload(), contract: hyperbach, provenance: { source: 'apify', runId: '7OHpRQhzrCbFHhLOj' } });
  e.sqlite.prepare("INSERT INTO jobs (id, title, url, status, reason) VALUES (?, ?, ?, 'error', ?)").run(
    heldJobId, fixedPricePayload().title, fixedPricePayload().url, 'Held: no bid can be computed from the saved snapshot. No budget or rate was stated.',
  );
  await persistSnapshot(e, { jobId: heldJobId, source: 'apify', partial: false, raw: fixedPricePayload(), contract: hyperbach, provenance: { source: 'apify-replay' } });
  expect(e.sqlite.prepare('SELECT status, reason FROM jobs WHERE id = ?').get(heldJobId)).toMatchObject({ status: 'matched', reason: 'Recovered public snapshot' });
  const kept = JSON.parse(String(e.sqlite.prepare('SELECT normalized FROM job_snapshots WHERE job_id = ?').get(heldJobId)?.normalized));
  expect(kept.listedCurrency).toBe('USD');
  expect(kept.budgetText).toBe('5.00');
  await persistSnapshot(e, { jobId: heldJobId, source: 'manual', partial: true, raw: { title: 'Only a title' }, provenance: { source: 'manual' } });
  const partial = JSON.parse(String(e.sqlite.prepare('SELECT normalized FROM job_snapshots WHERE job_id = ?').get(heldJobId)?.normalized));
  expect(partial.budgetText).toBe('5.00');
  expect(partial.listedCurrency).toBe('USD');
  expect((await addJob(e, { jobUrl: fixedPricePayload().url, title: fixedPricePayload().title, automatic: true })).ok).toBe(false);
  expect(e.sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(heldJobId)?.status).toBe('matched');
  const client = vi.spyOn(oauth, 'upworkClient');
  await addJob(e, { jobUrl: fixedPricePayload().url, title: fixedPricePayload().title });
  await runWriter(e);
  expect(client).not.toHaveBeenCalled();
  expect(e.sqlite.prepare('SELECT status, reason FROM jobs WHERE id = ?').get(heldJobId)).toMatchObject({
    status: 'filtered', reason: 'Budget $5 below $20',
  });
  expect(e.sqlite.prepare('SELECT count(*) n FROM proposals').get()?.n).toBe(0);
});

it('holds a price from an undocumented feed and does not confirm it', async () => {
  const e = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic' };
  await ready(e, 'auto');
  const s = structuredClone(DEFAULT_SETTINGS);
  s.bid = { hourly: 'profile', fixed: 'client_budget', profileRate: 30 };
  s.minFixedBudget = 20;
  s.fixedPriceTermsAcknowledged = true;
  s.letter = { template: 'Hi there,\n\nThe fixed letter.', opening: 'off', rules: '' };
  s.sendingEnabled = true;
  s.caps.activeStart = s.caps.activeEnd = '00:00';
  await saveSettings(e, s);
  await patchState(e, { upwork: { connected: true, orgUid: 'mock', toolNames: { find_jobs: 'find_jobs', confirm_preview: 'confirm_preview', manage_proposals: 'manage_proposals' } } });
  const aboveId = '2118988132749471493';
  const raw = { ...fixedPricePayload(), id: `02${aboveId}`, url: `https://www.upwork.com/jobs/~02${aboveId}`, price: 25 };
  await persistSnapshot(e, { jobId: aboveId, source: 'apify', partial: false, raw, provenance: { source: 'apify' } });
  await addJob(e, { jobUrl: raw.url, title: raw.title, automatic: true });
  const client = vi.spyOn(oauth, 'upworkClient');
  vi.stubGlobal('fetch', () => { throw new Error('network'); });
  vi.spyOn(claude, 'scoreJob').mockResolvedValue({ profileFit: 90, winSimilarity: null, reason: 'Synthetic fit', pros: [], cons: [] });
  vi.spyOn(loom, 'copyForJob').mockResolvedValue(null);
  await runWriter(e);
  const drafted = e.sqlite.prepare('SELECT status, approved_via, bid, budget, error FROM proposals').get() as { status: string; approved_via: string | null; bid: number | null; budget: string; error: string };
  expect(drafted).toMatchObject({ status: 'approved', approved_via: 'auto-submit', bid: 25, budget: '25.00' });
  expect(drafted.error).toMatch(/did not name a currency/);
  expect(drafted.error).not.toMatch(/USD 30|Rafa's rate/);
  expect(client).not.toHaveBeenCalled();
});

it('inserts a finished Claude draft after an interrupted queue write without generating again', async () => {
  const e = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic' };
  await ready(e, 'review');
  await persistSnapshot(e, { jobId: id, source: 'apify', partial: false, raw: rich(), provenance: { source: 'apify' } });
  await addJob(e, { jobUrl: `https://www.upwork.com/jobs/~02${id}`, title: rich().title, postedAt: rich().date_posted, automatic: true });
  const score = vi.spyOn(claude, 'scoreJob').mockResolvedValue({ profileFit: 90, winSimilarity: null, reason: 'Synthetic fit', pros: [], cons: [] });
  const copy = vi.spyOn(loom, 'copyForJob').mockResolvedValue({ id: 'copy1', url: 'https://www.loom.com/share/copy1' });
  const original = e.DB.batch.bind(e.DB);
  let failed = false;
  e.DB.batch = (async (queries) => {
    if (!failed) { failed = true; throw new Error('insert interrupted'); }
    return original(queries);
  }) as typeof e.DB.batch;
  await runWriter(e);
  expect(score).toHaveBeenCalledTimes(1);
  expect(copy).toHaveBeenCalledTimes(1);
  expect(e.sqlite.prepare('SELECT status FROM jobs').get()?.status).toBe('matched');
  expect(e.sqlite.prepare('SELECT count(*) n FROM proposals').get()?.n).toBe(0);
  expect(await getKv(e, draftReadyKey(id))).toBeTruthy();
  await runWriter(e);
  expect(score).toHaveBeenCalledTimes(1);
  expect(copy).toHaveBeenCalledTimes(1);
  expect(e.sqlite.prepare('SELECT status, loom_video_id FROM proposals').get()).toMatchObject({ status: 'pending', loom_video_id: 'copy1' });
});

it('holds an hourly listing when every price field is empty and keeps an applicant count of zero', () => {
  const snap = normalizePublicJob('2119192907272097615', {
    title: 'Email Marketing Campaign Manager', description: 'Manage the campaigns.',
    price_type: 'Hourly', price: null, price_min: null, price_max: null,
    buyer_payment_verified: true, client_total_applicants: 0,
  }, 'hyperbach-public-upwork');
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.bid = { hourly: 'profile', fixed: 'client_budget', profileRate: 30 };
  expect(snap.verification).toBe('VERIFIED');
  expect(snap.proposalCount).toBe(0);
  expect(snap.budgetText).toBeNull();
  expect(snap.budgetFault).toBeNull();
  expect(snap.listedCurrency).toBeNull();
  expect(computeBid('hourly', null, settings)).toBe(30);
  expect(draftBid(snap, structuredClone(DEFAULT_SETTINGS))).toEqual({ amount: 30, basis: 'bidder-hourly-usd' });
  expect(snapshotHoldReason(snap, settings)).toBeNull();
  expect(submissionGaps(snap, settings)).toEqual(['client-hourly-band-missing']);
  expect(submissionGaps(snap, settings)).not.toContain('applicant-count-missing');
  const namedEuro = normalizePublicJob('2119192907272097615', {
    title: 'Email Marketing Campaign Manager', description: 'Manage the campaigns.',
    price_type: 'Hourly', currency: 'EUR', buyer_payment_verified: true, client_total_applicants: 0,
  }, 'hyperbach-public-upwork');
  expect(namedEuro.explicitCurrency).toBe('EUR');
  expect(draftBid(namedEuro, settings)).toEqual({ amount: null, basis: 'unavailable' });
  const merged = mergeSnapshots(snap, { ...snap, proposalCount: null }, true);
  expect(merged.proposalCount).toBe(0);
});

it('returns a held job after a fuller import and auto-approves that future draft', async () => {
  const e = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic' };
  await ready(e, 'auto');
  const s = structuredClone(DEFAULT_SETTINGS);
  s.letter = { template: 'Hi there,\n\nThe fixed letter.', opening: 'off', rules: '' };
  s.sendingEnabled = true;
  s.fixedPriceTermsAcknowledged = true;
  s.caps.activeStart = s.caps.activeEnd = '00:00';
  await saveSettings(e, s);
  const jobId = '2119044137876131664';
  const url = `https://www.upwork.com/jobs/~02${jobId}`;
  await persistSnapshot(e, { jobId, source: 'automatic', partial: true, raw: { url, title: 'Klaviyo campaign manager' }, provenance: { source: 'automatic' } });
  e.sqlite.prepare("INSERT INTO jobs (id, title, url, status, reason) VALUES (?, 'Klaviyo campaign manager', ?, 'error', 'Held: the saved snapshot has no job description.')").run(jobId, url);
  await persistSnapshot(e, {
    jobId, source: 'automatic', partial: true,
    raw: { description: 'Still only a snippet, and still missing the other public fields.' },
    provenance: { source: 'automatic' },
  });
  expect(e.sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)?.status).toBe('error');
  e.sqlite.prepare("UPDATE jobs SET status = 'filtered', reason = 'Budget $5 below $20' WHERE id = ?").run(jobId);
  await persistSnapshot(e, {
    jobId, source: 'apify', partial: false, contract: 'hyperbach-public-upwork',
    raw: {
      title: 'Klaviyo campaign manager', description: 'Run the Klaviyo campaigns and send the weekly report.',
      price_type: 'Hourly', price_min: 30, price_max: 45, buyer_payment_verified: true, proposal_count: 4,
    },
    provenance: { source: 'apify' },
  });
  expect(e.sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)?.status).toBe('filtered');
  e.sqlite.prepare("UPDATE jobs SET status = 'error', reason = 'Held: the saved snapshot has no job description.' WHERE id = ?").run(jobId);
  await persistSnapshot(e, {
    jobId, source: 'apify', partial: false, contract: 'hyperbach-public-upwork',
    raw: {
      title: 'Klaviyo campaign manager', description: 'Run the Klaviyo campaigns and send the weekly report.',
      price_type: 'Hourly', price_min: 30, price_max: 45, buyer_payment_verified: true, proposal_count: 4,
    },
    provenance: { source: 'apify' },
  });
  expect(e.sqlite.prepare('SELECT status, reason FROM jobs WHERE id = ?').get(jobId)).toMatchObject({ status: 'matched', reason: 'Recovered public snapshot' });
  vi.spyOn(claude, 'scoreJob').mockResolvedValue({ profileFit: 90, winSimilarity: null, reason: 'Synthetic fit', pros: [], cons: [] });
  vi.spyOn(loom, 'copyForJob').mockResolvedValue(null);
  const client = vi.spyOn(oauth, 'upworkClient');
  await runWriter(e);
  expect(client).not.toHaveBeenCalled();
  expect(e.sqlite.prepare('SELECT status, approved_via, bid FROM proposals').get()).toMatchObject({ status: 'approved', approved_via: 'auto-submit', bid: 45 });
});

it('keeps a full post when a snippet or a cut text arrives, and accepts a shorter complete post', () => {
  const full = normalizePublicJob(id, { title: 'Klaviyo', description: 'Run the full Klaviyo campaign and report every week.' });
  const snippet = normalizePublicJob(id, { title: 'Klaviyo', description_snippet: 'Run the' });
  const shorter = normalizePublicJob(id, { title: 'Klaviyo', description: 'Shorter complete post.' });
  const cut = normalizePublicJob(id, { title: 'Klaviyo', description: 'x'.repeat(50_001) });
  expect(full.descriptionKind).toBe('body');
  expect(snippet.descriptionKind).toBe('fragment');
  expect(cut.descriptionTruncated).toBe(true);
  expect(mergeSnapshots(full, snippet, false).description).toBe(full.description);
  expect(mergeSnapshots(full, snippet, false).descriptionKind).toBe('body');
  expect(mergeSnapshots(snippet, full, false).description).toBe(full.description);
  expect(mergeSnapshots(full, shorter, false).description).toBe('Shorter complete post.');
  expect(mergeSnapshots(full, cut, false).description).toBe(full.description);
  expect(mergeSnapshots(full, full, false).description).toBe(full.description);
  expect(mergeSnapshots(full, snippet, true).description).toBe(full.description);
  expect(boundPromptDescription('Run the', false, true).note).toMatch(/search snippet or fragment, not the full job post/);
  expect(boundPromptDescription('Run the').note).toBeNull();
});

it('auto-approves a snippet draft when the letter has no internal wording', async () => {
  const e = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic' };
  await ready(e, 'auto');
  const jobId = '2119044137876131665';
  const url = `https://www.upwork.com/jobs/~02${jobId}`;
  e.sqlite.prepare("INSERT INTO jobs (id, title, url, status, reason) VALUES (?, 'Klaviyo campaign manager', ?, 'error', 'Held: the saved snapshot has no job description.')").run(jobId, url);
  await persistSnapshot(e, {
    jobId, source: 'automatic', partial: false,
    raw: { title: 'Klaviyo campaign manager', description: 'Run the', description_kind: 'fragment', buyer_payment_verified: true, proposal_count: 1, job_type: 'hourly', budget: '30.00–40.00/hr' },
    provenance: { source: 'automatic' },
  });
  expect(e.sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)?.status).toBe('error');
  const matchedId = '2119044137876131666';
  await persistSnapshot(e, {
    jobId: matchedId, source: 'automatic', partial: false,
    raw: { title: 'Klaviyo campaign manager', description: 'Run the weekly snippet.', description_kind: 'fragment', buyer_payment_verified: true, proposal_count: 1, job_type: 'hourly', budget: '30.00–40.00/hr' },
    provenance: { source: 'automatic' },
  });
  e.sqlite.prepare("INSERT INTO jobs (id, title, url, status, reason, posted_at) VALUES (?, 'Klaviyo campaign manager', ?, 'matched', 'Added by link', ?)").run(matchedId, `https://www.upwork.com/jobs/~02${matchedId}`, new Date().toISOString());
  const score = vi.spyOn(claude, 'scoreJob').mockResolvedValue({ profileFit: 90, winSimilarity: null, reason: 'Synthetic fit', pros: [], cons: [] });
  vi.spyOn(loom, 'copyForJob').mockResolvedValue(null);
  await runWriter(e);
  expect(score.mock.calls.some((call) => call[3]?.descriptionFragment === true)).toBe(true);
  expect(e.sqlite.prepare('SELECT status, approved_via, error FROM proposals WHERE job_id = ?').get(matchedId)).toMatchObject({ status: 'approved', approved_via: 'auto-submit' });
  expect(String(e.sqlite.prepare('SELECT error FROM proposals WHERE job_id = ?').get(matchedId)?.error)).toMatch(/snippet/);
  expect(e.sqlite.prepare('SELECT status, approved_via FROM proposals WHERE job_id = ?').get(jobId)).toMatchObject({ status: 'approved', approved_via: 'auto-submit' });
  expect(e.sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)?.status).toBe('proposed');
  await runWriter(e);
  expect(e.sqlite.prepare('SELECT count(*) n FROM proposals').get()?.n).toBe(2);
});

it('writes pending text for saved missing data and still auto-approves a complete post', async () => {
  const e = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic', APIFY_PROVIDER: 'hyperbach' as const };
  await ready(e, 'auto');
  const s = structuredClone(DEFAULT_SETTINGS);
  s.letter = { template: 'Hi there,\n\nThe fixed letter.', opening: 'sentence', rules: '' };
  s.maxNewJobsPerRun = 10;
  s.allowedCountries = ['Canada'];
  s.sendingEnabled = true;
  s.caps.activeStart = s.caps.activeEnd = '00:00';
  s.minFixedBudget = 20;
  await saveSettings(e, s);
  const titleId = '2119044137876131701';
  const hourlyId = '2119044137876131702';
  const unverifiedId = '2119044137876131703';
  const filteredId = '2119044137876131704';
  const zeroId = '2119044137876131705';
  const countryId = '2119044137876131706';
  const completeId = '2119044137876131707';
  const url = (jobId: string) => `https://www.upwork.com/jobs/~02${jobId}`;
  await persistSnapshot(e, { jobId: titleId, source: 'automatic', partial: false, raw: { title: 'Klaviyo campaign manager', url: url(titleId) }, provenance: { source: 'automatic' } });
  e.sqlite.prepare("INSERT INTO jobs (id, title, url, status, reason) VALUES (?, 'Klaviyo campaign manager', ?, 'error', 'Held: the saved snapshot has no job description.')").run(titleId, url(titleId));
  const hourlyRaw = { title: 'Klaviyo hourly manager', description: 'Run the Klaviyo campaigns and send the weekly report.', price_type: 'Hourly', price: null, price_min: null, price_max: null, buyer_payment_verified: true, client_total_applicants: 0 };
  const hourlySnap = normalizePublicJob(hourlyId, hourlyRaw, 'hyperbach-public-upwork');
  hourlySnap.budgetFault = 'malformed';
  e.sqlite.prepare(`INSERT INTO job_snapshots (job_id, source, fetched_at, provenance, raw_payload, raw_truncated, raw_original_bytes, normalized)
    VALUES (?, 'apify', ?, ?, ?, 0, ?, ?)`).run(hourlyId, new Date().toISOString(), JSON.stringify({ source: 'apify' }), JSON.stringify(hourlyRaw), JSON.stringify(hourlyRaw).length, JSON.stringify(hourlySnap));
  e.sqlite.prepare("INSERT INTO jobs (id, title, url, status, reason) VALUES (?, 'Klaviyo hourly manager', ?, 'error', 'Held: the feed price was zero, blank, or not a single positive amount. Nothing is drafted or sent.')").run(hourlyId, url(hourlyId));
  await persistSnapshot(e, {
    jobId: unverifiedId, source: 'apify', partial: false, contract: 'hyperbach-public-upwork',
    raw: { title: 'Klaviyo unverified client', description: 'Run the Klaviyo campaigns.', price_type: 'Hourly', price_min: 40, price_max: 55, buyer_payment_verified: false, proposal_count: 1, country: 'Canada' },
    provenance: { source: 'apify' },
  });
  e.sqlite.prepare("INSERT INTO jobs (id, title, url, status, reason) VALUES (?, 'Klaviyo unverified client', ?, 'error', 'Held: the saved snapshot has no job description.')").run(unverifiedId, url(unverifiedId));
  await persistSnapshot(e, {
    jobId: filteredId, source: 'apify', partial: false, contract: 'hyperbach-public-upwork',
    raw: { title: 'Klaviyo filtered budget', description: 'A complete Klaviyo post that was already filtered.', price_type: 'Hourly', price_min: 40, price_max: 55, buyer_payment_verified: true, proposal_count: 1, country: 'Canada' },
    provenance: { source: 'apify' },
  });
  e.sqlite.prepare("INSERT INTO jobs (id, title, url, status, reason) VALUES (?, 'Klaviyo filtered budget', ?, 'filtered', 'Budget $5 below $20')").run(filteredId, url(filteredId));
  await persistSnapshot(e, {
    jobId: countryId, source: 'apify', partial: false, contract: 'hyperbach-public-upwork',
    raw: { title: 'Klaviyo outside country', description: 'Run the Klaviyo campaigns.', price_type: 'Hourly', price_min: 40, price_max: 55, buyer_payment_verified: true, proposal_count: 1, country: 'United States' },
    provenance: { source: 'apify' },
  });
  e.sqlite.prepare("INSERT INTO jobs (id, title, url, status, reason) VALUES (?, 'Klaviyo outside country', ?, 'error', 'Held: the saved snapshot has no job description.')").run(countryId, url(countryId));
  await persistSnapshot(e, {
    jobId: zeroId, source: 'apify', partial: false, contract: 'hyperbach-public-upwork',
    raw: { title: 'Klaviyo zero rate', description: 'Run the Klaviyo campaigns.', price_type: 'Hourly', price_min: 0, price_max: 40, buyer_payment_verified: true, proposal_count: 1, country: 'Canada' },
    provenance: { source: 'apify' },
  });
  await addJob(e, { jobUrl: url(zeroId), title: 'Klaviyo zero rate', automatic: true });
  const client = vi.spyOn(oauth, 'upworkClient');
  const score = vi.spyOn(claude, 'scoreJob').mockResolvedValue({ profileFit: 90, winSimilarity: null, reason: 'Synthetic fit', pros: [], cons: [] });
  const opening = vi.spyOn(claude, 'writeOpening').mockResolvedValue('The weekly Klaviyo campaigns need the first flow set up before anything else.');
  vi.spyOn(loom, 'copyForJob').mockResolvedValue(null);
  await runWriter(e);
  expect(client).not.toHaveBeenCalled();
  const titleProposal = e.sqlite.prepare('SELECT id, status, approved_via, bid, budget, cover_letter, error FROM proposals WHERE job_id = ?').get(titleId) as { id: number; status: string; approved_via: string | null; bid: number | null; budget: string | null; cover_letter: string; error: string };
  expect(titleProposal).toMatchObject({ status: 'approved', approved_via: 'auto-submit', bid: null, budget: null });
  expect(titleProposal.cover_letter).toContain(openingFromTitle('Klaviyo campaign manager'));
  expect(metaLanguageIn(titleProposal.cover_letter)).toBeNull();
  expect(titleProposal.cover_letter).not.toMatch(/saved job post|did not include a description|this sentence/i);
  expect(titleProposal.error).toMatch(/job description/);
  expect(titleProposal.error).toMatch(/No job type was stated/);
  expect(opening.mock.calls.every((call) => String((call[5] as { description?: string } | undefined)?.description ?? '').trim().length > 0)).toBe(true);
  const hourly = e.sqlite.prepare('SELECT status, approved_via, bid, budget, error, create_params FROM proposals WHERE job_id = ?').get(hourlyId) as { status: string; approved_via: string | null; bid: number; budget: string | null; error: string; create_params: string };
  expect(hourly).toMatchObject({ status: 'approved', approved_via: 'auto-submit', bid: 30, budget: null });
  expect(JSON.parse(hourly.create_params)).toMatchObject({ bid_basis: 'bidder-hourly-usd', bidder_hourly_usd: 30 });
  expect(hourly.error).toMatch(/not the client's budget/);
  expect(e.sqlite.prepare('SELECT budget FROM jobs WHERE id = ?').get(hourlyId)?.budget).toBeNull();
  expect(JSON.parse(String(e.sqlite.prepare('SELECT normalized FROM job_snapshots WHERE job_id = ?').get(hourlyId)?.normalized)).budgetFault).toBeNull();
  expect(score.mock.calls.some((call) => (call[3] as { clientHourlyUnstated?: boolean }).clientHourlyUnstated === true)).toBe(true);
  expect(e.sqlite.prepare('SELECT status, reason FROM jobs WHERE id = ?').get(unverifiedId)).toMatchObject({ status: 'filtered', reason: 'Client payment not verified' });
  expect(e.sqlite.prepare('SELECT status, reason FROM jobs WHERE id = ?').get(countryId)?.reason).toMatch(/Client country/);
  expect(e.sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(filteredId)?.status).toBe('filtered');
  expect(e.sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(zeroId)?.status).toBe('error');
  expect(e.sqlite.prepare('SELECT count(*) n FROM proposals WHERE job_id IN (?, ?, ?, ?)').get(unverifiedId, countryId, filteredId, zeroId)?.n).toBe(0);
  await runWriter(e);
  expect(e.sqlite.prepare('SELECT count(*) n FROM proposals WHERE job_id = ?').get(titleId)?.n).toBe(1);
  const long = 'Run the full Klaviyo campaign and report every week in detail.';
  const shorter = 'Shorter complete Klaviyo post.';
  await persistSnapshot(e, {
    jobId: completeId, source: 'apify', partial: false, contract: 'hyperbach-public-upwork',
    raw: { title: 'Klaviyo complete post', description: long, price_type: 'Hourly', price_min: 40, price_max: 55, buyer_payment_verified: true, proposal_count: 2, country: 'Canada' },
    provenance: { source: 'apify' },
  });
  await persistSnapshot(e, {
    jobId: completeId, source: 'apify', partial: false, contract: 'hyperbach-public-upwork',
    raw: { title: 'Klaviyo complete post', description: shorter, price_type: 'Hourly', price_min: 40, price_max: 55, buyer_payment_verified: true, proposal_count: 2, country: 'Canada' },
    provenance: { source: 'apify' },
  });
  expect(JSON.parse(String(e.sqlite.prepare('SELECT normalized FROM job_snapshots WHERE job_id = ?').get(completeId)?.normalized)).description).toBe(shorter);
  await addJob(e, { jobUrl: url(completeId), title: 'Klaviyo complete post', automatic: true });
  await runWriter(e);
  expect(client).not.toHaveBeenCalled();
  expect(e.sqlite.prepare('SELECT status, approved_via, bid, budget FROM proposals WHERE job_id = ?').get(completeId)).toMatchObject({ status: 'approved', approved_via: 'auto-submit', bid: 55, budget: '40.00–55.00/hr' });
  expect(submissionBlock(normalizePublicJob(completeId, { title: 'Klaviyo complete post', description: shorter, price_type: 'Hourly', price_min: 40, price_max: 55, buyer_payment_verified: true, proposal_count: 2, country: 'Canada' }, 'hyperbach-public-upwork'), s)).toBeNull();
});

it('keeps Review drafts pending, blocks an internal letter before Upwork, and does not auto-send a fixed job with no amount', async () => {
  expect(DEFAULT_STATE.mode).toBe('review');
  const review = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic' };
  await ready(review, 'review');
  const reviewSettings = structuredClone(DEFAULT_SETTINGS);
  reviewSettings.keywords = ['CAPES'];
  reviewSettings.letter = { template: 'Hi there,\n\nThe fixed letter.', opening: 'sentence', rules: '' };
  await saveSettings(review, reviewSettings);
  const titleId = '2119044137876131711';
  await persistSnapshot(review, { jobId: titleId, source: 'automatic', partial: false, raw: { title: 'CAPES', url: `https://www.upwork.com/jobs/~02${titleId}` }, provenance: { source: 'automatic' } });
  review.sqlite.prepare("INSERT INTO jobs (id, title, url, status, reason) VALUES (?, 'CAPES', ?, 'matched', 'Added by link')").run(titleId, `https://www.upwork.com/jobs/~02${titleId}`);
  vi.spyOn(claude, 'scoreJob').mockResolvedValue({ profileFit: 90, winSimilarity: null, reason: 'Synthetic fit', pros: [], cons: [] });
  vi.spyOn(loom, 'copyForJob').mockResolvedValue(null);
  await runWriter(review);
  const reviewed = review.sqlite.prepare('SELECT status, approved_via, cover_letter FROM proposals').get() as { status: string; approved_via: string | null; cover_letter: string };
  expect(reviewed).toMatchObject({ status: 'pending', approved_via: null });
  expect(reviewed.cover_letter).toContain(openingFromTitle('CAPES'));
  expect(metaLanguageIn(reviewed.cover_letter)).toBeNull();

  const blocked = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic' };
  await ready(blocked, 'auto');
  const s = structuredClone(DEFAULT_SETTINGS);
  s.letter = { template: 'Hi there,\n\nThe fixed letter.', opening: 'off', rules: '' };
  s.sendingEnabled = true;
  s.caps.activeStart = s.caps.activeEnd = '00:00';
  s.fixedPriceTermsAcknowledged = true;
  await saveSettings(blocked, s);
  const leaked = 'The saved job post did not include a description, so this sentence adds no requirement that was not stated.';
  blocked.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, create_params) VALUES ('2119044137876131712', 'CAPES', ?, 30, 'hourly', 'approved', 'auto-submit', datetime('now'), '{}')").run(leaked);
  await patchState(blocked, { upwork: { connected: true, orgUid: 'mock', toolNames: { find_jobs: 'find_jobs', confirm_preview: 'confirm_preview' } } });
  const client = vi.spyOn(oauth, 'upworkClient');
  await runSender(blocked);
  expect(client).not.toHaveBeenCalled();
  expect(blocked.sqlite.prepare('SELECT status, approved_via FROM proposals').get()).toMatchObject({ status: 'pending', approved_via: null });

  const fixedId = '2119044137876131713';
  await persistSnapshot(blocked, {
    jobId: fixedId, source: 'apify', partial: false, contract: 'hyperbach-public-upwork',
    raw: { title: 'Klaviyo fixed project', description: 'Design the Klaviyo emails.', price_type: 'Fixed-price', buyer_payment_verified: true, proposal_count: 1 },
    provenance: { source: 'apify' },
  });
  await addJob(blocked, { jobUrl: `https://www.upwork.com/jobs/~02${fixedId}`, title: 'Klaviyo fixed project', automatic: true });
  await runWriter(blocked);
  expect(blocked.sqlite.prepare('SELECT status, approved_via, bid FROM proposals WHERE job_id = ?').get(fixedId)).toMatchObject({ status: 'pending', approved_via: null, bid: null });
  expect(client).not.toHaveBeenCalled();
});
