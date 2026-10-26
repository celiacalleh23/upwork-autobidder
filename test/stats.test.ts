import { describe, expect, it } from 'vitest';
import { parseWhen, readProposalPages } from '../src/pipeline/stats';

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
