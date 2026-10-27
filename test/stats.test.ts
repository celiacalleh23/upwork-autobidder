import { describe, expect, it } from 'vitest';
import { newConnectsRun, parseWhen, readBoosters, readConnectsPages, readProposalPages, spendKind } from '../src/pipeline/stats';

describe('parseWhen', () => {
  const t = Date.parse('2026-05-01T10:00:00Z');
  it('reads ISO text, epoch seconds and milliseconds, and nested values', () => {
    expect(parseWhen('2026-05-01T10:00:00Z')).toBe(t);
    expect(parseWhen(t)).toBe(t);
    expect(parseWhen(t / 1000)).toBe(t);
    expect(parseWhen(String(t))).toBe(t);
    expect(parseWhen({ rawValue: String(t) })).toBe(t);
    expect(parseWhen({ value: '2026-05-01T10:00:00Z' })).toBe(t);
  });
  it('returns NaN when it cannot read a date', () => {
    expect(parseWhen(undefined)).toBeNaN();
    expect(parseWhen('yesterday-ish')).toBeNaN();
    expect(parseWhen({ foo: 1 })).toBeNaN();
  });
});

describe('readProposalPages', () => {
  // A fake Upwork that lists `total` proposals 10 per page, newest first, one an hour.
  const fake = (total: number, now: number) => {
    let calls = 0;
    const client = {
      get calls() { return calls; },
      async callTool(_t: string, args: { params: { cursor?: string } }) {
        calls++;
        const start = Number(args.params.cursor ?? 0);
        const rows = Array.from({ length: Math.max(0, Math.min(10, total - start)) }, (_, i) => ({
          node: { createdDateTime: new Date(now - (start + i) * 3600_000).toISOString(), viewedByClient: (start + i) % 4 === 0 },
        }));
        return { edges: rows, pageInfo: { hasNextPage: start + 10 < total, endCursor: String(start + 10) } };
      },
    };
    return client;
  };
  const now = Date.parse('2026-10-26T12:00:00Z');
  const far = now - 365 * 86400_000;

  it('counts past 30 by resuming from the cursor', async () => {
    const c = fake(47, now);
    const a = await readProposalPages(c as never, 'list', 'org', 'Accepted', far, null, 3);
    expect(a).toMatchObject({ n: 30, pages: 3, done: false, cursor: '30' });
    const b = await readProposalPages(c as never, 'list', 'org', 'Accepted', far, a.cursor, 25);
    expect(b).toMatchObject({ n: 17, done: true });
    expect(a.n + b.n).toBe(47);
    expect(a.viewed + b.viewed).toBe(12); // every 4th, 0..46
  });
  it('stops at the first proposal older than the period', async () => {
    const c = fake(200, now);
    const r = await readProposalPages(c as never, 'list', 'org', 'Accepted', now - 24.5 * 3600_000, null, 25);
    expect(r).toMatchObject({ n: 25, done: true });
    expect(c.calls).toBe(3);
  });
});

describe('spendKind (what Connects paid for)', () => {
  it('reads the reasons seen on a real account', () => {
    expect(spendKind('Job application', true)).toBe('applications');
    expect(spendKind('Refund job cancellation', true)).toBe('applications');
    expect(spendKind('Behavioral based subsidy', false)).toBe('other');
  });
  it('splits boosts, Profile Boost and the Availability Badge', () => {
    expect(spendKind('Boosted proposal', true)).toBe('proposalBoosts');
    expect(spendKind('Proposal boost bid', false)).toBe('proposalBoosts');
    expect(spendKind('Boosted profile', false)).toBe('profileBoost');
    expect(spendKind('Profile ad spend', false)).toBe('profileBoost');
    expect(spendKind('Availability badge', false)).toBe('badge');
    expect(spendKind('Available now badge weekly charge', false)).toBe('badge');
    expect(spendKind('Job no longer available', true)).toBe('applications'); // job-linked refunds are never the badge
  });
});

describe('readBoosters', () => {
  it('reads boost_profile get_status as Upwork returns it', () => {
    const off = { data: { badge_status: { purchasedInvitationBadgeStatus: { statuses: [{ status: false }] } }, boost_status: null,
      pib_details: { pibStatus: { active: false, currentPrice: 14, maxPrice: 14, nextRenewalAt: null, status: 'OFF' } } } };
    expect(readBoosters(off)).toEqual({ badge: { active: false, price: 14, renewsAt: null }, profileBoost: null });
    const on = { data: { boost_status: { status: 'ACTIVE', bid: { rawValue: '20' } },
      pib_details: { pibStatus: { active: true, currentPrice: 14, nextRenewalAt: '2026-11-03T00:00:00Z', status: 'ON' } } } };
    expect(readBoosters(on)).toEqual({ badge: { active: true, price: 14, renewsAt: '2026-11-03T00:00:00Z' }, profileBoost: { status: 'ACTIVE', bid: 20 } });
  });
});

describe('readConnectsPages', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  // Shaped like get_profile connects_balance on a real account: usage_history.transactions, pageInfo, hasMore.
  const tx = (i: number) => {
    const at = new Date(now - i * 3600_000).toISOString();
    if (i % 10 === 9) return { amount: { rawValue: '-14' }, createdDateTime: at, jobPost: null, reason: 'Availability badge', transactionType: 'Connects spent' };
    if (i % 10 === 5) return { amount: { rawValue: '-3' }, createdDateTime: at, jobPost: { jobId: '~02x' }, reason: 'Boosted proposal', transactionType: 'Connects spent' };
    if (i % 10 === 7) return { amount: { rawValue: '8' }, createdDateTime: at, jobPost: { jobId: '~02y' }, reason: 'Refund job cancellation', transactionType: 'Connects refunded' };
    if (i % 10 === 8) return { amount: { rawValue: '100' }, createdDateTime: at, jobPost: null, reason: 'Purchased', transactionType: 'Connects received' };
    return { amount: { rawValue: '-8' }, createdDateTime: at, jobPost: { jobId: '~02z' }, reason: 'Job application', transactionType: 'Connects spent' };
  };
  const fake = (total: number) => ({
    async callTool(_t: string, args: { params: { cursor?: string } }) {
      const start = Number(args.params.cursor ?? 0);
      const more = start + 10 < total;
      return { balance: { connectsBalance: 600 }, hasMore: more, product_credits: { profile_ads: { balance: 50 } },
        usage_history: { pageInfo: { endCursor: String(start + 10), hasNextPage: more }, transactions: Array.from({ length: Math.min(10, total - start) }, (_, i) => tx(start + i)) } };
    },
  });

  it('splits Connects by kind and resumes across requests', async () => {
    const run = newConnectsRun();
    const far = now - 365 * 86400_000;
    expect(await readConnectsPages(fake(30) as never, 'p', 'org', far, run, 2)).toBe(2);
    expect(run).toMatchObject({ done: false, cursor: '20' });
    expect(await readConnectsPages(fake(30) as never, 'p', 'org', far, run, 25)).toBe(1);
    expect(run.done).toBe(true);
    // 30 transactions: per 10, six applications (8), one boost (3), one refund (8), one purchase (100), one badge (14).
    expect(run.byKind.applications).toEqual({ n: 18, spent: 144, refunded: 24 });
    expect(run.byKind.proposalBoosts).toEqual({ n: 3, spent: 9, refunded: 0 });
    expect(run.byKind.badge).toEqual({ n: 3, spent: 42, refunded: 0 });
    expect(run.byKind.profileBoost.n + run.byKind.other.n).toBe(0);
    expect(run.received).toBe(300);
    expect(run.balance).toBe(600);
    expect(run.adCredits).toEqual({ profile_ads: 50 });
  });
  it('stops at the first transaction older than the period', async () => {
    const run = newConnectsRun();
    await readConnectsPages(fake(200) as never, 'p', 'org', now - 14.5 * 3600_000, run, 25);
    expect(run.done).toBe(true);
    expect(run.pages).toBe(2);
    expect(run.byKind.applications.n + run.byKind.proposalBoosts.n + run.byKind.badge.n).toBe(13); // hours 0–14 are 15 transactions, minus a refund and a purchase
  });
});
