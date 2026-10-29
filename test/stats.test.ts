import { describe, expect, it } from 'vitest';
import { parseLedgerPage, parseWhen, readBoosters, readProposalPages, resolveRange, spendKind, summarizeLedger } from '../src/pipeline/stats';
import { throttleWait } from '../src/mcp';

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

describe('parseLedgerPage (Connects history, stored in D1)', () => {
  // A page as get_profile connects_balance returned it on a real account (Oct 27).
  const page = {
    balance: { connectsBalance: 40 }, hasMore: true, product_credits: { profile_ads: { balance: 50 } },
    usage_history: { pageInfo: { endCursor: 'MCw0NTk4', hasNextPage: true }, transactions: [
      { amount: { rawValue: '10' }, createdDateTime: '2026-10-16T10:05:53Z', jobPost: null, reason: 'Behavioral based subsidy', transactionType: 'Connects received' },
      { amount: { rawValue: '14' }, createdDateTime: '2026-10-16T07:37:55Z', jobPost: { jobId: '~0221', jobTitle: '<untrusted_participant_content>Recreate Klaviyo flows</untrusted_participant_content>' }, reason: 'Refund job cancellation', transactionType: 'Connects refunded' },
      { amount: { rawValue: '-14' }, createdDateTime: '2026-10-15T23:24:44Z', jobPost: { jobId: '~0221', jobTitle: 'Recreate Klaviyo flows' }, reason: 'Job application', transactionType: 'Connects spent' },
      { amount: { rawValue: '-3' }, createdDateTime: 'not a date', jobPost: null, reason: 'Job application', transactionType: 'Connects spent' },
    ] },
  };
  it('reads each transaction with a stable key, its kind and a positive amount', () => {
    const p = parseLedgerPage(page);
    expect(p.next).toBe('MCw0NTk4');
    expect(p.credits).toEqual({ profile_ads: 50 });
    expect(p.rows).toHaveLength(3); // the unreadable date is skipped, never guessed
    expect(p.rows[1]).toMatchObject({ type: 'refunded', amount: 14, kind: 'applications', jobId: '~0221', jobTitle: 'Recreate Klaviyo flows' });
    expect(p.rows[2]).toMatchObject({ type: 'spent', amount: 14, kind: 'applications' });
    expect(p.rows[2].key).toBe('2026-10-15T23:24:44.000Z|spent|14|~0221|Job application');
    expect(parseLedgerPage(page).rows.map((r) => r.key)).toEqual(p.rows.map((r) => r.key)); // same page, same keys
  });
  it('ends at the last page', () => {
    expect(parseLedgerPage({ ...page, hasMore: false }).next).toBeNull();
    expect(parseLedgerPage({ hasMore: true, usage_history: { pageInfo: { hasNextPage: true, endCursor: 'x' }, transactions: [] } }).next).toBeNull();
  });
});

describe('summarizeLedger', () => {
  it('adds up a period by kind', () => {
    const s = summarizeLedger([
      { kind: 'applications', type: 'spent', n: 18, amt: 144 }, { kind: 'applications', type: 'refunded', n: 3, amt: 24 },
      { kind: 'proposalBoosts', type: 'spent', n: 3, amt: 9 }, { kind: 'badge', type: 'spent', n: 2, amt: 28 },
      { kind: 'other', type: 'received', n: 3, amt: 300 }, { kind: 'mystery', type: 'spent', n: 1, amt: 5 },
    ]);
    expect(s.byKind.applications).toEqual({ n: 18, spent: 144, refunded: 24 });
    expect(s.byKind.other).toEqual({ n: 1, spent: 5, refunded: 0 }); // an unknown kind is counted, never dropped
    expect(s).toMatchObject({ spent: 186, refunded: 24, received: 300 });
  });
});

describe('throttleWait (Upwork asks to slow down)', () => {
  it('reads how long Upwork asked to wait', () => {
    const real = 'Upwork find_jobs: {"error_code":"SENSITIVE_RATE_LIMIT_EXCEEDED","reason":"Rate limit exceeded for this tool. Wait about 5 seconds before retrying (~12 requests/min sustained for find_jobs, find_freelancers, get_profile, and write tools). There is no daily cap — limits refill continuously."}';
    expect(throttleWait(new Error(real))).toBe(6000);
    expect(throttleWait(new Error('429 Too Many Requests'))).toBe(11000);
    expect(throttleWait(new Error('Rate limit exceeded, wait about 300 seconds'))).toBe(31000); // capped
    expect(throttleWait(new Error('Job is closed'))).toBeNull();
    expect(throttleWait(new Error('Too many requests: account restricted'))).toBeNull(); // a warning is never a wait
  });
});

describe('resolveRange (Rafa\'s account period)', () => {
  const tz = 'America/Los_Angeles';
  const now = Date.parse('2026-10-29T18:30:00Z'); // 11:30 am Oct 29 in Los Angeles (PDT, UTC-7)
  it('reads today and yesterday as calendar days in the Settings time zone', () => {
    expect(resolveRange({ range: 'today' }, tz, now)).toMatchObject({ from: Date.parse('2026-10-29T07:00:00Z'), to: now, label: 'Today' });
    expect(resolveRange({ range: 'yesterday' }, tz, now)).toMatchObject({ from: Date.parse('2026-10-28T07:00:00Z'), to: Date.parse('2026-10-29T07:00:00Z') });
  });
  it('keeps rolling windows and the old days field', () => {
    expect(resolveRange({ range: '7' }, tz, now)).toMatchObject({ from: now - 7 * 86400_000, to: now, label: 'Last 7 days' });
    expect(resolveRange({ days: 90 }, tz, now)).toMatchObject({ key: '90', label: 'Last 90 days' });
    expect(resolveRange({}, tz, now).key).toBe('30');
  });
  it('reads a custom range from whole calendar days, across a DST change', () => {
    const r = resolveRange({ range: 'custom', from: '2026-10-31', to: '2026-11-02' }, tz, Date.parse('2026-11-10T00:00:00Z'));
    expect(r.from).toBe(Date.parse('2026-10-31T07:00:00Z')); // PDT
    expect(r.to).toBe(Date.parse('2026-11-03T08:00:00Z'));   // PST, end of Nov 2
    expect(r.label).toBe('Oct 31, 2026 – Nov 2, 2026');
    expect(resolveRange({ range: 'custom', from: '2026-10-20', to: '2026-10-29' }, tz, now).to).toBe(now); // up to today: now
  });
  it('refuses a bad custom range', () => {
    expect(() => resolveRange({ range: 'custom', from: '2026-10-20' }, tz, now)).toThrow('Pick a start and an end date');
    expect(() => resolveRange({ range: 'custom', from: '2026-10-25', to: '2026-10-20' }, tz, now)).toThrow('after the end');
    expect(() => resolveRange({ range: 'custom', from: '2026-11-01', to: '2026-11-02' }, tz, now)).toThrow('future');
    expect(() => resolveRange({ range: 'custom', from: '2024-01-01', to: '2026-10-01' }, tz, now)).toThrow('at most');
    expect(() => resolveRange({ range: 'week' }, tz, now)).toThrow('Unknown period');
  });
});

describe('period end (yesterday read today)', () => {
  it('skips proposals newer than the period', async () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    const rows = Array.from({ length: 10 }, (_, i) => ({ node: { createdDateTime: new Date(now - i * 6 * 3600_000).toISOString() } }));
    const client = { async callTool() { return { edges: rows, pageInfo: { hasNextPage: false } }; } };
    // Hours 0, 6, 12, 18 ago are newer than `until` (19 h ago); 24…54 h ago fall inside.
    const r = await readProposalPages(client as never, 'list', 'org', 'Accepted', now - 60 * 3600_000, null, 5, now - 19 * 3600_000);
    expect(r.n).toBe(6);
  });
});
