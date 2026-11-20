import { afterEach, expect, it, vi } from 'vitest';
import * as claude from '../src/claude';
import * as oauth from '../src/oauth';
import { persistSnapshot } from '../src/pipeline/snapshot';
import { runWriter } from '../src/pipeline/write';
import { DEFAULT_SETTINGS, patchState, saveSettings, type Env } from '../src/settings';
import { environment } from './support/db';

const databases: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); databases.push(e); return e; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach((e) => e.sqlite.close()); });

const FIRST = 'Your welcome flow is the fastest win in this post.';
const SECOND = 'I would rebuild it in Klaviyo before the campaigns.';
const BAD = 'Reach me on WhatsApp about the welcome flow, and see my site rafa.com.';
const TITLE = 'Klaviyo welcome flows';
const DESCRIPTION = 'Rebuild the welcome flow and the browse series.';

async function prepare(e: Env, jobId: string, independent: boolean) {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.letter = { template: 'Hi there,\n\n{opening}\n\nThe fixed letter.', opening: 'sentence', rules: '' };
  await saveSettings(e, s);
  if (independent) {
    await persistSnapshot(e, {
      jobId, source: 'automatic', partial: false,
      raw: {
        title: TITLE, description: DESCRIPTION, url: `https://www.upwork.com/jobs/~02${jobId}`,
        job_type: 'hourly', budget: '40.00–55.00/hr', buyer_payment_verified: true, proposal_count: 3, country: 'United States',
      },
      provenance: { source: 'automatic' },
    });
    await patchState(e, { mode: 'review', paused: false });
  } else {
    await patchState(e, {
      mode: 'review', paused: false,
      upwork: { connected: true, orgUid: 'mock', toolNames: { find_jobs: 'find_jobs', list_freelancer_proposals: 'list_freelancer_proposals', manage_proposals: 'manage_proposals' } },
    });
  }
  e.sqlite.prepare("INSERT INTO jobs (id, title, url, status, job_type, budget) VALUES (?, ?, ?, 'matched', 'hourly', '40.00–55.00/hr')")
    .run(jobId, TITLE, `https://www.upwork.com/jobs/~02${jobId}`);
}

function mockModel(text: string) {
  vi.spyOn(claude, 'scoreJob').mockResolvedValue({ profileFit: 90, winSimilarity: null, reason: 'Synthetic fit', pros: [], cons: [] });
  return vi.spyOn(claude, 'writeOpening').mockResolvedValue(text);
}

function mockUpwork() {
  const callTool = vi.fn(async (name: string) => {
    if (name === 'list_freelancer_proposals') return { invitations: [] };
    if (name === 'find_jobs') return {
      connects_cost: 8, connects_balance: 80, can_apply: true, applied: false, verification_status: 'VERIFIED', proposal_count: 3,
      marketplaceJobPosting: {
        content: { title: TITLE, description: DESCRIPTION },
        clientCompanyPublic: { country: { name: 'United States' } },
        contractTerms: { contractType: 'HOURLY', hourlyContractTerms: { hourlyBudgetMin: 40, hourlyBudgetMax: 55 } },
      },
    };
    if (name === 'manage_proposals') return { preview_id: 'preview-1', connects_cost: 8, can_apply: true, questions: [] };
    throw new Error(`unexpected tool ${name}`);
  });
  vi.spyOn(oauth, 'upworkClient').mockResolvedValue({ callTool } as never);
  return callTool;
}

async function queuedLetter(e: Env, jobId: string) {
  const summary = await runWriter(e);
  const job = e.sqlite.prepare('SELECT status, reason FROM jobs WHERE id = ?').get(jobId) as { status: string; reason: string | null };
  const proposal = e.sqlite.prepare('SELECT status, cover_letter FROM proposals WHERE job_id = ?').get(jobId) as { status: string; cover_letter: string } | undefined;
  return { summary, job, proposal };
}

it.each([
  ['independent drafts', true, '2119044137876132101'],
  ['upwork writer', false, '2119044137876132102'],
] as const)('%s queues a proposal when the model returns a bad opening twice', async (_label, independent, jobId) => {
  const e = { ...env(), ...(independent ? { INDEPENDENT_DRAFTS: 'true' } : {}), ANTHROPIC_API_KEY: 'synthetic' };
  await prepare(e, jobId, independent);
  const opening = mockModel(BAD);
  const client = vi.spyOn(oauth, 'upworkClient');
  if (!independent) mockUpwork();
  const { summary, job, proposal } = await queuedLetter(e, jobId);
  expect(opening).toHaveBeenCalledTimes(2);
  expect(typeof opening.mock.calls[1]?.[6]).toBe('string');
  expect(summary).toMatchObject({ queued: 1, errors: 0 });
  expect(job.status).toBe('proposed');
  expect(job.reason ?? '').not.toMatch(/Letter rejected twice/);
  expect(proposal?.status).toBe('pending');
  expect(proposal?.cover_letter ?? '').not.toMatch(/whatsapp|rafa\.com/i);
  if (independent) expect(client).not.toHaveBeenCalled();
});

it.each([
  ['independent drafts', true, '2119044137876132103'],
  ['upwork writer', false, '2119044137876132104'],
] as const)('%s trims a two-sentence opening and queues it', async (_label, independent, jobId) => {
  const e = { ...env(), ...(independent ? { INDEPENDENT_DRAFTS: 'true' } : {}), ANTHROPIC_API_KEY: 'synthetic' };
  await prepare(e, jobId, independent);
  const opening = mockModel(`${FIRST} ${SECOND}`);
  if (!independent) mockUpwork();
  const { summary, job, proposal } = await queuedLetter(e, jobId);
  expect(opening).toHaveBeenCalledTimes(2);
  expect(summary).toMatchObject({ queued: 1, errors: 0 });
  expect(job.status).toBe('proposed');
  expect(job.reason ?? '').not.toMatch(/Letter rejected/);
  expect(proposal?.status).toBe('pending');
  expect(proposal?.cover_letter).toContain(FIRST);
  expect(proposal?.cover_letter).not.toContain(SECOND);
});

it('repairs third person before trimming, and still queues', async () => {
  const e = { ...env(), INDEPENDENT_DRAFTS: 'true', ANTHROPIC_API_KEY: 'synthetic' };
  const jobId = '2119044137876132105';
  await prepare(e, jobId, true);
  const text = 'Rafa would start with the welcome flow in this post. Then the campaigns get a second pass.';
  mockModel(text);
  vi.spyOn(claude, 'rewriteLetter').mockImplementation(async (letter) => letter);
  vi.spyOn(oauth, 'upworkClient');
  const { job, proposal } = await queuedLetter(e, jobId);
  expect(job.status).toBe('proposed');
  expect(proposal?.cover_letter).toContain('I would start with the welcome flow in this post.');
  expect(proposal?.cover_letter).not.toContain('Then the campaigns');
  expect(proposal?.cover_letter).not.toMatch(/\bRafa would\b/);
});
