import { afterEach, expect, it } from 'vitest';
import { handleApi } from '../src/api';
import { CONNECT_USD, buildMonthConnects, loadMonthConnects, monthStartUtc } from '../src/pipeline/connectsReport';
import { DEFAULT_SETTINGS, saveSettings } from '../src/settings';
import { environment } from './support/db';

const databases: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); databases.push(e); return e; };
afterEach(() => { databases.splice(0).forEach((e) => e.sqlite.close()); });

it('builds November from submitted proposals and the saved Connects history', () => {
  const boosts = [22, 3, 251, 32];
  const proposals = Array.from({ length: 34 }, (_, i) => ({
    connects: i === 0 ? 497 - 33 : 1,
    boostConnects: boosts[i] ?? 0,
  }));
  const ledger = [
    { type: 'spent', reason: 'Job application', amount: 16 },
    { type: 'spent', reason: 'Sponsored proposal auction deposit', amount: 22 },
    { type: 'spent', reason: 'Sponsored proposal auction deposit', amount: 7 },
    { type: 'refunded', reason: 'Interview won', amount: 22 },
    { type: 'refunded', reason: 'Refund job cancellation', amount: 9 },
    { type: 'refunded', reason: 'Refund job cancellation', amount: 9 },
    { type: 'received', reason: 'Behavioral based subsidy', amount: 34 },
    { type: 'received', reason: 'Interview won', amount: 10 },
  ];
  const report = buildMonthConnects(proposals, ledger);
  expect(report.proposals).toEqual({ charges: 34, connects: 497 });
  expect(report.boosts).toEqual({ charges: 4, connects: 308 });
  expect(report.auctionDeposits).toEqual({ charges: 2, connects: 29 });
  expect(report.refunds).toEqual({ charges: 3, connects: 40 });
  expect(report.received).toEqual({ charges: 2, connects: 44 });
  expect(report.total).toEqual({ charges: 38, connects: 497 + 308 - 40 });
  expect(report.boosts.connects).not.toBe(report.auctionDeposits.connects);
  expect(report.proposals.connects * CONNECT_USD).toBeCloseTo(74.55, 2);
});

it('leaves a proposal from the previous month out of the report', async () => {
  const e = env();
  const s = structuredClone(DEFAULT_SETTINGS);
  s.caps.timezone = 'UTC';
  await saveSettings(e, s);
  const now = new Date('2026-11-10T15:00:00Z');
  expect(monthStartUtc('UTC', now)).toBe('2026-11-01 00:00:00');
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status, connects, boost_connects, submitted_at) VALUES ('2119920699600682201', 'October', 'Hi', 'submitted', 16, 0, '2026-10-31 23:00:00')").run();
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status, connects, boost_connects, submitted_at) VALUES ('2119920699600682202', 'November', 'Hi', 'submitted', 11, 3, '2026-11-09 14:45:52')").run();
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status, connects, boost_connects, submitted_at) VALUES ('2119920699600682203', 'Waiting', 'Hi', 'pending', 99, 50, '2026-11-09 14:45:52')").run();
  e.sqlite.prepare("INSERT INTO connects_ledger (key, at, type, reason, amount, kind) VALUES ('a', '2026-11-05T12:00:00.000Z', 'refunded', 'Refund job cancellation', 8, 'applications')").run();
  e.sqlite.prepare("INSERT INTO connects_ledger (key, at, type, reason, amount, kind) VALUES ('b', '2026-10-05T12:00:00.000Z', 'refunded', 'Refund job cancellation', 100, 'applications')").run();
  const report = await loadMonthConnects(e, now);
  expect(report.month).toBe('November 2026');
  expect(report.proposals).toEqual({ charges: 1, connects: 11 });
  expect(report.boosts).toEqual({ charges: 1, connects: 3 });
  expect(report.refunds).toEqual({ charges: 1, connects: 8 });
  expect(report.total.connects).toBe(11 + 3 - 8);
  const res = await handleApi(new Request('https://local.invalid/api/connects-report'), e, '/api/connects-report');
  expect(res.status).toBe(200);
  expect((await res.json()).proposals.connects).toBe(11);
});
