import { readFileSync } from 'node:fs';
import { setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { handleApi } from '../src/api';
import * as claude from '../src/claude';
import { seal } from '../src/crypto';
import { putKv } from '../src/kv';
import { persistSnapshot } from '../src/pipeline/snapshot';
import { runWriter } from '../src/pipeline/write';
import { runSender } from '../src/pipeline/send';
import { autoSendWait } from '../src/pipeline/pace';
import { sendGate } from '../src/pipeline/sendRules';
import { displayNote } from '../src/pipeline/proposalNote';
import { STALL_NOTE, recoverSubmittedRows, requeueNeverConfirmed } from '../src/pipeline/submitted';
import { BIDDER_HOURLY_USD, FIXED_ESTIMATE_USD, NATURAL_SCREENING_ANSWER, cleanScreeningAnswer, resolveSendBid } from '../src/pipeline/letter';
import { DEFAULT_SETTINGS, DEFAULT_STATE, patchState, saveSettings, type Env } from '../src/settings';
import { environment } from './support/db';

const databases: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); databases.push(e); return e; };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); databases.splice(0).forEach((e) => e.sqlite.close()); });

async function finishPipeline<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const settled = work.then((value) => { done = true; return { value }; }, (error) => { done = true; return { error }; });
  for (let i = 0; i < 1000 && !done; i++) {
    await realDelay(1);
    if (vi.getTimerCount()) await vi.advanceTimersToNextTimerAsync();
  }
  const result = await settled;
  if ('error' in result) throw result.error;
  return result.value;
}

async function connected(e: Env) {
  await patchState(e, { mode: 'review', upwork: { connected: true, account: 'Synthetic', orgUid: 'mock', toolNames: {
    find_jobs: 'find_jobs', list_freelancer_proposals: 'list_freelancer_proposals', get_freelancer_dashboard: 'get_freelancer_dashboard', manage_proposals: 'manage_proposals', confirm_preview: 'confirm_preview',
  } } });
  await putKv(e, 'upwork_tokens', await seal(e, { accessToken: 'synthetic', expiresAt: Date.now() + 3600_000 }));
}

async function sendApproved(e: Env, opts: { questions?: string[] | null; boost?: number; proposalId?: string } = {}) {
  vi.useFakeTimers();
  await putKv(e, 'upwork_tokens', await seal(e, { accessToken: 'synthetic', expiresAt: Date.now() + 3_600_000 }));
  let confirms = 0;
  const boostBids: number[] = [];
  vi.spyOn(claude, 'answerQuestions').mockImplementation(async (_env, _profile, _job, questions: string[]) => questions.map((question) => ({ question, answer: 'I can start on this next week.' })));
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(String(url)).toBe(e.UPWORK_MCP_URL);
    const m = JSON.parse(String(init.body));
    let result: unknown = {};
    if (m.method === 'initialize') result = { protocolVersion: '2025-06-18' };
    if (m.method === 'tools/call') {
      const name = m.params.name;
      let data: unknown = {};
      if (name === 'get_freelancer_dashboard') data = { connectsBalance: 40 };
      if (name === 'find_jobs') data = { connects_cost: 8, connects_balance: 40, can_apply: true, applied: false };
      if (name === 'list_freelancer_proposals') data = m.params.arguments.action === 'invitations' ? { invitations: [] } : { proposals: [] };
      if (name === 'manage_proposals') {
        if (m.params.arguments.params?.boost_connects) boostBids.push(m.params.arguments.params.boost_connects);
        data = { preview_id: 'synthetic-preview', connects_cost: 8, can_apply: true, ...(opts.questions === null ? {} : { questions: opts.questions ?? [] }), ...(opts.boost !== undefined ? { boost: { available: true, recommended_connects: opts.boost, max_boost_connects: 600 } } : {}) };
      }
      if (name === 'confirm_preview') { confirms++; data = { status: 'submitted', data: { createJobProposal: { status: 'SUCCESS', newProposalId: opts.proposalId ?? '2119803710405586945', error: null } } }; }
      result = { structuredContent: data };
    }
    return new Response(m.id === undefined ? null : JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { status: m.id === undefined ? 202 : 200, headers: { 'content-type': 'application/json' } });
  });
  await finishPipeline(runSender(e));
  vi.useRealTimers();
  return { confirms, boostBids };
}

const post = (path: string) => new Request('https://local.invalid' + path, { method: 'POST', headers: { 'x-dashboard': '1' } });

it('1. Missing description: the proposal is written and sent', async () => {
  const e = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic' };
  const s = structuredClone(DEFAULT_SETTINGS);
  s.keywords = ['Klaviyo'];
  s.letter = { template: 'Hi there,\n\n{opening}\n\nThe fixed letter.', opening: 'sentence', rules: '' };
  s.sendingEnabled = true;
  s.caps.activeStart = s.caps.activeEnd = '00:00';
  s.caps.boostInAuto = false;
  await saveSettings(e, s);
  await patchState(e, { mode: 'review', paused: false });
  const jobId = '2119044137876131991';
  await persistSnapshot(e, { jobId, source: 'automatic', partial: false, raw: { title: 'Klaviyo email flows' }, provenance: { source: 'automatic' } });
  e.sqlite.prepare("INSERT INTO jobs (id, title, url, status) VALUES (?, 'Klaviyo email flows', ?, 'matched')").run(jobId, `https://www.upwork.com/jobs/~02${jobId}`);
  vi.spyOn(claude, 'scoreJob').mockResolvedValue({ profileFit: 90, winSimilarity: null, reason: 'Synthetic fit', pros: [], cons: [] });
  vi.spyOn(claude, 'writeOpening').mockResolvedValue('The welcome series for this store is where I would start.');
  await runWriter(e);
  const drafted = e.sqlite.prepare('SELECT id, status, error, bid, job_type, cover_letter FROM proposals').get() as { id: number; status: string; error: string | null; bid: number; job_type: string; cover_letter: string };
  expect(drafted).toMatchObject({ status: 'pending', error: null, bid: BIDDER_HOURLY_USD, job_type: 'hourly' });
  expect(drafted.cover_letter).toContain('The welcome series for this store is where I would start.');
  expect((await handleApi(post(`/api/proposals/${drafted.id}/approve`), e, `/api/proposals/${drafted.id}/approve`)).status).toBe(200);
  await connected(e);
  const sent = await sendApproved(e, { questions: null });
  expect(sent.confirms).toBe(1);
  expect(e.sqlite.prepare('SELECT status, error FROM proposals').get()).toMatchObject({ status: 'submitted', error: null });
});

it('2. Missing applicant count with a manual Approve: it sends, with no Not sent message', async () => {
  const e = env();
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = true; s.caps.activeStart = s.caps.activeEnd = '00:00'; s.caps.boostInAuto = false;
  await saveSettings(e, s);
  await connected(e);
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, create_params, error) VALUES ('2119044137876131992', 'Klaviyo flows', 'Hi there, the letter is ready for this Klaviyo job.', 30, 'hourly', 'approved', 'dashboard', datetime('now'), ?, NULL)")
    .run(JSON.stringify({ missing: ['applicant-count-missing'], bid_basis: 'bidder-hourly-usd' }));
  const sent = await sendApproved(e, { questions: [] });
  expect(sent.confirms).toBe(1);
  const row = e.sqlite.prepare('SELECT status, error FROM proposals').get() as { status: string; error: string | null };
  expect(row.status).toBe('submitted');
  expect(row.error ?? '').not.toMatch(/Not sent|applicant/);
});

it('3. Missing client rate: the bid is USD 30/hr and it sends', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  expect(resolveSendBid({ jobType: 'hourly', bid: null, bidBasis: null, liveType: null, liveBudget: null, settings })).toMatchObject({ bid: 30, basis: 'bidder-hourly-usd', hold: null });
  const e = env();
  settings.sendingEnabled = true; settings.caps.activeStart = settings.caps.activeEnd = '00:00'; settings.caps.boostInAuto = false;
  await saveSettings(e, settings);
  await connected(e);
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, create_params) VALUES ('2119044137876131993', 'Klaviyo flows', 'Hi there, the letter is ready for this Klaviyo job.', NULL, 'hourly', 'approved', 'dashboard', datetime('now'), '{}')").run();
  expect((await sendApproved(e)).confirms).toBe(1);
  expect(e.sqlite.prepare('SELECT status, bid FROM proposals').get()).toMatchObject({ status: 'submitted', bid: 30 });
});

it('4. Unknown job type: it is treated as hourly at USD 30/hr', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  expect(resolveSendBid({ jobType: null, bid: null, bidBasis: null, liveType: null, liveBudget: null, settings })).toEqual({ jobType: 'hourly', bid: BIDDER_HOURLY_USD, basis: 'bidder-hourly-usd', hold: null });
});

it('5. Fixed-price job with no amount: an amount is inferred and it sends', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  expect(resolveSendBid({ jobType: 'fixed', bid: null, bidBasis: null, liveType: 'fixed', liveBudget: null, settings }).bid).toBe(FIXED_ESTIMATE_USD);
  const e = env();
  settings.sendingEnabled = true; settings.caps.activeStart = settings.caps.activeEnd = '00:00'; settings.caps.boostInAuto = false; settings.fixedPriceTermsAcknowledged = true;
  await saveSettings(e, settings);
  await connected(e);
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, create_params) VALUES ('2119044137876131994', 'Klaviyo project', 'Hi there, the letter is ready for this Klaviyo job.', NULL, 'fixed', 'approved', 'dashboard', datetime('now'), '{}')").run();
  expect((await sendApproved(e)).confirms).toBe(1);
  expect(e.sqlite.prepare('SELECT status, bid FROM proposals').get()).toMatchObject({ status: 'submitted', bid: FIXED_ESTIMATE_USD });
});

it('6. Null or empty screening questions: it sends', async () => {
  for (const questions of [null, [] as string[]]) {
    const e = env();
    const s = structuredClone(DEFAULT_SETTINGS);
    s.sendingEnabled = true; s.caps.activeStart = s.caps.activeEnd = '00:00'; s.caps.boostInAuto = false;
    await saveSettings(e, s);
    await connected(e);
    e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, create_params) VALUES ('2119044137876131995', 'Klaviyo flows', 'Hi there, the letter is ready for this Klaviyo job.', 30, 'hourly', 'approved', 'dashboard', datetime('now'), '{}')").run();
    expect((await sendApproved(e, { questions })).confirms).toBe(1);
    expect(e.sqlite.prepare('SELECT status, error FROM proposals').get()).toMatchObject({ status: 'submitted', error: null });
  }
});

it('7. New or changed screening questions: they are answered automatically and it sends', async () => {
  const e = env();
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = true; s.caps.activeStart = s.caps.activeEnd = '00:00'; s.caps.boostInAuto = false;
  await saveSettings(e, s);
  await connected(e);
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, create_params) VALUES ('2119044137876131996', 'Klaviyo flows', 'Hi there, the letter is ready for this Klaviyo job.', 30, 'hourly', 'approved', 'dashboard', datetime('now'), ?)")
    .run(JSON.stringify({ answers: [{ question: 'Old question', answer: 'Old answer' }] }));
  const sent = await sendApproved(e, { questions: ['How soon can you start?'] });
  expect(sent.confirms).toBe(1);
  expect(e.sqlite.prepare('SELECT status FROM proposals').get()?.status).toBe('submitted');
  expect(claude.answerQuestions).toHaveBeenCalled();
});

it('8. Manual Approve: no random delay, and the request does not start a cancellable send', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sendingEnabled = true;
  settings.caps.gapMinutes = 10;
  const state = { ...structuredClone(DEFAULT_STATE), lastSendAt: new Date().toISOString(), upwork: { ...DEFAULT_STATE.upwork, connected: true } };
  expect(sendGate(state, settings, { sentToday: 0, sentLastHour: 0 }, new Date(), true)).toBeNull();
  expect(await autoSendWait(env(), { ...state, mode: 'review' })).toBeNull();
  const e = env();
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status) VALUES ('2119044137876131997', 'Klaviyo flows', 'Hi there, the letter is ready for this Klaviyo job.', 'pending')").run();
  const waits: Promise<unknown>[] = [];
  expect((await handleApi(post('/api/proposals/1/approve'), e, '/api/proposals/1/approve', { waitUntil: (p) => { waits.push(p); } })).status).toBe(200);
  expect(waits).toHaveLength(0);
  expect(e.sqlite.prepare('SELECT status, approved_via FROM proposals').get()).toMatchObject({ status: 'approved', approved_via: 'dashboard' });
});

it('9. Auto-mode approvals: the random delay is still applied', async () => {
  const e = env();
  const at = Date.parse('2026-11-09T15:00:00Z');
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const wait = await autoSendWait(e, { ...structuredClone(DEFAULT_STATE), mode: 'auto', lastSendAt: new Date(at).toISOString() }, at + 60_000);
  expect(wait).toMatch(/random \/ humanized/);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sendingEnabled = true;
  const state = { ...structuredClone(DEFAULT_STATE), mode: 'auto' as const, lastSendAt: new Date().toISOString(), upwork: { ...DEFAULT_STATE.upwork, connected: true } };
  expect(sendGate(state, settings, { sentToday: 0, sentLastHour: 0 }, new Date(), false)).toMatch(/min apart/);
});

it('10. Upwork returns a proposal id: the status is submitted right away', async () => {
  const e = env();
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status, upwork_proposal_id, submitted_at) VALUES ('2119759541811767698', 'Klaviyo Email Flow Fixes & Optimization', 'Hi there, the letter is ready.', 'submitting', '2119803710405586945', datetime('now', '-1 day'))").run();
  await runSender(e);
  expect(e.sqlite.prepare('SELECT status, upwork_proposal_id, submitted_at FROM proposals').get()).toMatchObject({
    status: 'submitted', upwork_proposal_id: '2119803710405586945',
  });
  const fresh = env();
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = true; s.caps.activeStart = s.caps.activeEnd = '00:00'; s.caps.boostInAuto = false;
  await saveSettings(fresh, s);
  await connected(fresh);
  fresh.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, create_params) VALUES ('2119044137876131998', 'Klaviyo flows', 'Hi there, the letter is ready for this Klaviyo job.', 30, 'hourly', 'approved', 'dashboard', datetime('now'), '{}')").run();
  await sendApproved(fresh, { proposalId: '2119803710405586946' });
  const row = fresh.sqlite.prepare('SELECT status, upwork_proposal_id FROM proposals').get() as { status: string; upwork_proposal_id: string };
  expect(row).toEqual({ status: 'submitted', upwork_proposal_id: '2119803710405586946' });
  expect(row.status).not.toBe('submitting');
});

it('11. Boost with missing inputs: the boost follows the saved settings', async () => {
  const e = env();
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = true; s.caps.activeStart = s.caps.activeEnd = '00:00';
  s.caps.boostInAuto = true; s.caps.boostMinScore = 85; s.caps.boostMaxConnects = 500;
  await saveSettings(e, s);
  await connected(e);
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, score, status, approved_via, approved_at, create_params) VALUES ('2119044137876131999', 'Klaviyo flows', 'Hi there, the letter is ready for this Klaviyo job.', 30, 'hourly', NULL, 'approved', 'dashboard', datetime('now'), ?)")
    .run(JSON.stringify({ missing: ['applicant-count-missing', 'description-missing'] }));
  const sent = await sendApproved(e, { questions: null, boost: 2 });
  expect(sent.boostBids).toEqual([2]);
  expect(e.sqlite.prepare('SELECT status, boost_connects FROM proposals').get()).toMatchObject({ status: 'submitted', boost_connects: 2 });
});

it('12. Internal wording in a letter: it is rewritten automatically, and held only if the rewrite fails', async () => {
  const leaked = 'The saved job post did not include a description, so this sentence adds no requirement that was not stated.';
  const clean = 'Hi there, the Klaviyo flows in your post are where I would start.';
  const held = env();
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = true; s.caps.activeStart = s.caps.activeEnd = '00:00'; s.caps.boostInAuto = false;
  await saveSettings(held, s);
  await connected(held);
  held.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, create_params) VALUES ('2119044137876132001', 'Klaviyo flows', ?, 30, 'hourly', 'approved', 'dashboard', datetime('now'), '{}')").run(leaked);
  const rewrite = vi.spyOn(claude, 'rewriteLetter');
  rewrite.mockResolvedValueOnce(leaked);
  expect((await sendApproved(held)).confirms).toBe(0);
  expect(held.sqlite.prepare('SELECT status, approved_via FROM proposals').get()).toMatchObject({ status: 'pending', approved_via: null });

  const fixed = env();
  await saveSettings(fixed, s);
  await connected(fixed);
  fixed.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, create_params) VALUES ('2119044137876132002', 'Klaviyo flows', ?, 30, 'hourly', 'approved', 'dashboard', datetime('now'), '{}')").run(leaked);
  rewrite.mockResolvedValueOnce(clean);
  expect((await sendApproved(fixed)).confirms).toBe(1);
  const row = fixed.sqlite.prepare('SELECT status, cover_letter FROM proposals').get() as { status: string; cover_letter: string };
  expect(row.status).toBe('submitted');
  expect(row.cover_letter).toBe(clean);
});

it('a third-person letter is rewritten to first person and still sends', async () => {
  const leaked = 'Hi there,\n\nGetting your Klaviyo workflows, campaigns and forms talking to WooCommerce and WordPress without gaps is the real job here, so Rafa would start by mapping each form and customer journey to the right list or flow.\n\nTalk soon,\nRafa';
  const e = env();
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = true; s.caps.activeStart = s.caps.activeEnd = '00:00'; s.caps.boostInAuto = false;
  await saveSettings(e, s);
  await connected(e);
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, create_params) VALUES ('2119044137876132011', 'Klaviyo flows', ?, 30, 'hourly', 'approved', 'dashboard', datetime('now'), ?)").run(leaked, JSON.stringify({ answers: [{ question: 'Tell us about yourself', answer: 'Rafa has nine years in Klaviyo.' }] }));
  vi.spyOn(claude, 'rewriteLetter').mockResolvedValue(leaked);
  expect((await sendApproved(e, { questions: null })).confirms).toBe(1);
  const row = e.sqlite.prepare('SELECT status, cover_letter, create_params FROM proposals').get() as { status: string; cover_letter: string; create_params: string };
  expect(row.status).toBe('submitted');
  expect(row.cover_letter).toContain('so I would start by mapping each form and customer journey');
  expect(row.cover_letter).not.toContain('Rafa would');
  expect(row.cover_letter).toContain('Talk soon,\nRafa');
  expect(JSON.parse(row.create_params).answers[0].answer).toBe('I have nine years in Klaviyo.');
});

it('13. The dashboard renders no amber or missing notes, for old and new rows', async () => {
  const oldNote = "Saved from the public snapshot. Still missing in the source: applicant count. Rafa's rate $30/hr · missing: applicant count";
  const screening = 'Upwork did not return screening questions. Nothing was sent.';
  expect(displayNote({ error: oldNote, status: 'pending', missing: ['applicant-count-missing'] })).toEqual({ text: null, error: false });
  expect(displayNote({ error: screening, status: 'skipped' })).toEqual({ text: null, error: false });
  expect(displayNote({ error: 'Upwork refused the proposal: the job is closed.', status: 'failed' }).error).toBe(true);
  const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  expect(html).not.toContain('note quiet');
  expect(html).toContain('.card .note, .st-cell .note{background:transparent');
  const e = env();
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status, error, create_params) VALUES ('2119044137876132003', 'Old row', 'Hi there, the letter is ready.', 'pending', ?, ?)")
    .run(oldNote, JSON.stringify({ missing: ['applicant-count-missing'], bid_basis: 'bidder-hourly-usd' }));
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status, error) VALUES ('2119044137876132004', 'Screening row', 'Hi there, the letter is ready.', 'skipped', ?)").run(screening);
  const log = await handleApi(new Request('https://local.invalid/api/log'), e, '/api/log');
  const body = await log.json() as { rows: { note: string | null; note_error: boolean }[] };
  expect(body.rows.every((row) => row.note === null && row.note_error === false)).toBe(true);
});

it('14. Skip records skipped_at', async () => {
  const e = env();
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status) VALUES ('2119044137876132005', 'Klaviyo flows', 'Hi there, the letter is ready.', 'pending')").run();
  expect((await handleApi(post('/api/proposals/1/skip'), e, '/api/proposals/1/skip')).status).toBe(200);
  const row = e.sqlite.prepare('SELECT status, skipped_at, skipped_by FROM proposals').get() as { status: string; skipped_at: string | null; skipped_by: string | null };
  expect(row.status).toBe('skipped');
  expect(row.skipped_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
  expect(row.skipped_by).toBeNull();
  const log = await handleApi(new Request('https://local.invalid/api/log'), e, '/api/log');
  const body = await log.json() as { rows: { status: string; skipped_at: string | null }[] };
  expect(body.rows[0].status).toBe('skipped');
  expect(body.rows[0].skipped_at).toMatch(/T/);
});

it('a manually approved proposal cancelled before a preview is not marked failed', async () => {
  const e = env();
  const bad = "I can't paste links here, but I'm happy to share my flow framework.";
  e.sqlite.prepare(`INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, submitted_at, error, create_params)
    VALUES ('2119920699600682073', 'Klaviyo Email Manager for 8-Figure DTC Brand', 'Hi there, the letter is ready for this Klaviyo job.', 30, 'hourly', 'failed', 'dashboard', '2026-11-10 00:25:25', '2026-11-10 00:25:48', 'Manually checked on Upwork: not sent. No automatic retry.', ?)`).run(JSON.stringify({
    missing: ['applicant-count-missing'], questions_state: 'hints',
    answers: [{ question: 'Send a link or screenshots of the Klaviyo flows you have built.', answer: bad }],
  }));
  await requeueNeverConfirmed(e);
  expect(e.sqlite.prepare('SELECT status, approved_via, submitted_at, error, preview_id, upwork_proposal_id FROM proposals').get()).toMatchObject({
    status: 'approved', approved_via: 'dashboard', submitted_at: null, error: null, preview_id: null, upwork_proposal_id: null,
  });
  const stuck = env();
  stuck.sqlite.prepare(`INSERT INTO proposals (job_id, title, cover_letter, status, approved_via, approved_at, submitted_at)
    VALUES ('2119920699600682074', 'Klaviyo flows', 'Hi there, the letter is ready for this Klaviyo job.', 'submitting', 'dashboard', '2026-11-10 00:25:25', '2026-11-10 00:25:48')`).run();
  await runSender(stuck);
  expect(stuck.sqlite.prepare('SELECT status, error, submitted_at FROM proposals').get()).toMatchObject({ status: 'approved', error: null, submitted_at: null });
});

it('confirm not sent puts a never-previewed manual approval back instead of failing it', async () => {
  const e = env();
  e.sqlite.prepare(`INSERT INTO proposals (job_id, title, cover_letter, status, approved_via, approved_at, error)
    VALUES ('2119920699600682075', 'Klaviyo flows', 'Hi there, the letter is ready for this Klaviyo job.', 'unknown', 'dashboard', '2026-11-10 00:25:25', 'Interrupted while sending; checking on Upwork, not resending')`).run();
  const req = new Request('https://local.invalid/api/proposals/1/resolve-unknown', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' },
    body: JSON.stringify({ outcome: 'not_sent', confirm: true }),
  });
  expect((await handleApi(req, e, '/api/proposals/1/resolve-unknown')).status).toBe(200);
  expect(e.sqlite.prepare('SELECT status, error, approved_via FROM proposals').get()).toMatchObject({ status: 'approved', error: null, approved_via: 'dashboard' });
});

it('a screening answer that says it cannot paste links is replaced with a natural answer', async () => {
  const bad = "I can't paste links here, but I'm happy to share my flow framework, email design samples and client video testimonials with you directly in an Upwork message.";
  expect(cleanScreeningAnswer(bad)).toBe(NATURAL_SCREENING_ANSWER);
  expect(cleanScreeningAnswer('I can start on this next week.')).toBe('I can start on this next week.');
  const e = env();
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = true; s.caps.activeStart = s.caps.activeEnd = '00:00'; s.caps.boostInAuto = false;
  await saveSettings(e, s);
  await connected(e);
  e.sqlite.prepare(`INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, score, status, approved_via, approved_at, create_params)
    VALUES ('2119920699600682073', 'Klaviyo Email Manager for 8-Figure DTC Brand', 'Hi there, the letter is ready for this Klaviyo job.', 30, 'hourly', 92, 'approved', 'dashboard', datetime('now'), ?)`).run(JSON.stringify({
    missing: ['applicant-count-missing'], questions_state: 'hints',
    answers: [{ question: 'Send a link or screenshots of the Klaviyo flows you have built.', answer: bad }],
  }));
  expect((await sendApproved(e, { questions: [] })).confirms).toBe(1);
  const params = JSON.parse(String(e.sqlite.prepare('SELECT create_params FROM proposals').get()?.create_params)) as { answers: { answer: string }[] };
  expect(params.answers[0].answer).toBe(NATURAL_SCREENING_ANSWER);
  expect(params.answers[0].answer).not.toMatch(/paste links/i);
});

it('a stalled pre-preview send is retried automatically and submits', async () => {
  const e = env();
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = true;
  s.caps.activeStart = s.caps.activeEnd = '00:00';
  s.caps.gapMinutes = 10;
  s.caps.boostInAuto = false;
  await saveSettings(e, s);
  await connected(e);
  await patchState(e, { lastSendAt: new Date().toISOString() });
  e.sqlite.prepare(`INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, submitted_at)
    VALUES ('2119920699600682101', 'Stalled Klaviyo send', 'Hi there, the letter is ready for this Klaviyo job.', 30, 'hourly', 'submitting', 'dashboard', '2026-11-10 00:25:25', '2026-11-10 00:25:48')`).run();
  e.sqlite.prepare(`INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at)
    VALUES ('2119920699600682102', 'Later manual send', 'Hi there, the letter is ready for this Klaviyo job.', 30, 'hourly', 'approved', 'dashboard', '2026-11-10 14:00:00')`).run();
  await putKv(e, 'send:stall:1', JSON.stringify({ open: true, n: 0 }));
  const sent = await sendApproved(e, { questions: [] });
  expect(sent.confirms).toBe(1);
  expect(e.sqlite.prepare('SELECT status, upwork_proposal_id FROM proposals WHERE id = 1').get()).toMatchObject({ status: 'submitted' });
  expect(e.sqlite.prepare('SELECT status FROM proposals WHERE id = 2').get()?.status).toBe('approved');
});

it('pre-preview retries are bounded and then show a short neutral note', async () => {
  const e = env();
  e.sqlite.prepare(`INSERT INTO proposals (job_id, title, cover_letter, status, approved_via, approved_at, submitted_at)
    VALUES ('2119920699600682103', 'Stalled Klaviyo send', 'Hi there, the letter is ready for this Klaviyo job.', 'submitting', 'dashboard', '2026-11-10 00:25:25', '2026-11-10 00:25:48')`).run();
  await putKv(e, 'send:stall:1', JSON.stringify({ open: true, n: 2 }));
  await runSender(e);
  const row = e.sqlite.prepare('SELECT status, approved_via, error FROM proposals').get() as { status: string; approved_via: string | null; error: string };
  expect(row).toMatchObject({ status: 'pending', approved_via: null, error: STALL_NOTE });
  expect(displayNote({ error: row.error, status: row.status })).toEqual({ text: STALL_NOTE, error: false });
});

it('a possibly-sent attempt is not blindly resent', async () => {
  const e = env();
  const s = structuredClone(DEFAULT_SETTINGS);
  s.sendingEnabled = true;
  s.caps.activeStart = s.caps.activeEnd = '00:00';
  s.caps.boostInAuto = false;
  await saveSettings(e, s);
  await connected(e);
  e.sqlite.prepare(`INSERT INTO proposals (job_id, title, cover_letter, bid, job_type, status, approved_via, approved_at, submitted_at, preview_id)
    VALUES ('2119920699600682104', 'Maybe sent', 'Hi there, the letter is ready for this Klaviyo job.', 30, 'hourly', 'submitting', 'dashboard', '2026-11-10 00:25:25', datetime('now'), 'preview-already')`).run();
  await putKv(e, 'send:stall:1', JSON.stringify({ open: true, n: 0 }));
  const sent = await sendApproved(e, { questions: [] });
  expect(sent.confirms).toBe(0);
  expect(e.sqlite.prepare('SELECT status, preview_id, upwork_proposal_id FROM proposals').get()).toMatchObject({
    status: 'submitting', preview_id: 'preview-already', upwork_proposal_id: null,
  });
});

it('recovers a Sending row directly when it already has an Upwork proposal id', async () => {
  const e = env();
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status, upwork_proposal_id) VALUES ('2119759541811767698', 'Klaviyo Email Flow Fixes & Optimization', 'Hi there.', 'submitting', '2119803710405586945')").run();
  await recoverSubmittedRows(e);
  expect(e.sqlite.prepare('SELECT status, submitted_at FROM proposals').get()).toMatchObject({ status: 'submitted' });
});
