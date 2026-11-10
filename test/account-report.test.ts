import { afterEach, expect, it } from 'vitest';
import { handleApi } from '../src/api';
import { CONNECT_USD } from '../src/pipeline/connectsReport';
import { buildLocalAccount, loadLocalAccount, resolveRange } from '../src/pipeline/stats';
import { DEFAULT_SETTINGS, patchState, saveSettings } from '../src/settings';
import { environment } from './support/db';

const databases: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); databases.push(e); return e; };
afterEach(() => { databases.splice(0).forEach((e) => e.sqlite.close()); });

const boosts = [22, 3, 251, 32];

it('counts boost bids on the proposals, and keeps refunds out of that row', () => {
  const proposals = [
    ...boosts.map((boostConnects, i) => ({ connects: 10 + i, boostConnects })),
    { connects: 16, boostConnects: 0 },
  ];
  const ledger = [
    { type: 'spent', amount: 497 },
    { type: 'spent', amount: 29 }, // auction deposits must not become the boost row
    { type: 'refunded', amount: 22 },
    { type: 'refunded', amount: 18 },
    { type: 'received', amount: 44 },
  ];
  const report = buildLocalAccount(proposals, ledger);
  expect(report.applications).toEqual({ charges: 5, connects: 10 + 11 + 12 + 13 + 16, recorded: true });
  expect(report.boosts).toEqual({ charges: 4, connects: 308, recorded: true });
  expect(report.boosts.connects).toBe(22 + 3 + 251 + 32);
  expect(report.total).toEqual({ charges: 9, connects: report.applications.connects + 308, recorded: true });
  expect(report.refunds).toEqual({ charges: 2, connects: 40, recorded: true });
  expect(report.received).toEqual({ charges: 1, connects: 44, recorded: true });
  expect(report.profileBoost).toEqual({ charges: 0, connects: 0, recorded: false });
  expect(report.badge).toEqual({ charges: 0, connects: 0, recorded: false });
  expect(report.viewed).toBeNull();
  expect(report.total.connects).not.toBe(report.applications.connects + 308 - 40);
  expect(report.boosts.connects * CONNECT_USD).toBeCloseTo(46.2, 2);
});

it('keeps a proposal outside the selected period out of both rows', async () => {
  const e = env();
  const s = structuredClone(DEFAULT_SETTINGS);
  s.caps.timezone = 'America/Los_Angeles';
  await saveSettings(e, s);
  await patchState(e, { connectsBalance: 2960 });
  const now = Date.parse('2026-11-11T18:00:00Z');
  const early = '2026-11-02 20:00:00'; // Nov 2, noon Pacific: inside Nov 1–10, outside Nov 4–10
  const inside = ['2026-11-05 20:00:00', '2026-11-06 20:00:00', '2026-11-07 20:00:00', '2026-11-08 20:00:00'];
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status, connects, boost_connects, submitted_at) VALUES ('2119920699600682301', 'Early', 'Hi', 'submitted', 10, 22, ?)").run(early);
  inside.forEach((at, i) => {
    e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status, connects, boost_connects, submitted_at) VALUES (?, 'Later', 'Hi', 'submitted', ?, ?, ?)").run(`21199206996006823${i + 2}`, 11 + i, boosts[i + 1] ?? 0, at);
  });
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status, connects, boost_connects, submitted_at) VALUES ('2119920699600682306', 'October', 'Hi', 'submitted', 100, 50, '2026-10-31 20:00:00')").run();
  e.sqlite.prepare("INSERT INTO proposals (job_id, title, cover_letter, status, connects, boost_connects, submitted_at) VALUES ('2119920699600682307', 'Waiting', 'Hi', 'pending', 99, 40, '2026-11-06 20:00:00')").run();
  e.sqlite.prepare("INSERT INTO connects_ledger (key, at, type, reason, amount, kind) VALUES ('r1', '2026-11-02T20:00:00.000Z', 'refunded', 'Interview won', 22, 'applications')").run();
  e.sqlite.prepare("INSERT INTO connects_ledger (key, at, type, reason, amount, kind) VALUES ('r2', '2026-11-06T20:00:00.000Z', 'refunded', 'Refund job cancellation', 18, 'applications')").run();
  e.sqlite.prepare("INSERT INTO connects_ledger (key, at, type, reason, amount, kind) VALUES ('d1', '2026-11-06T20:00:00.000Z', 'spent', 'Sponsored proposal auction deposit', 29, 'proposalBoosts')").run();
  e.sqlite.prepare("INSERT INTO connects_ledger (key, at, type, reason, amount, kind) VALUES ('g1', '2026-11-06T21:00:00.000Z', 'received', 'Behavioral based subsidy', 34, 'other')").run();

  const full = resolveRange({ range: 'custom', from: '2026-11-01', to: '2026-11-10' }, 'America/Los_Angeles', now);
  const later = resolveRange({ range: 'custom', from: '2026-11-04', to: '2026-11-10' }, 'America/Los_Angeles', now);
  const a = await loadLocalAccount(e, full, now);
  const b = await loadLocalAccount(e, later, now);
  expect(a.proposalsSent).toBe(5);
  expect(a.boosts).toMatchObject({ charges: 4, connects: 308 });
  expect(a.applications.connects).toBe(10 + 11 + 12 + 13 + 14);
  expect(a.total.connects).toBe(a.applications.connects + 308);
  expect(a.refunds.connects).toBe(40);
  expect(a.received.connects).toBe(34);
  expect(a.balance).toBe(2960);
  expect(b.proposalsSent).toBe(4);
  expect(b.boosts).toMatchObject({ charges: 3, connects: 3 + 251 + 32 });
  expect(b.applications.connects).toBe(11 + 12 + 13 + 14);
  expect(b.refunds.connects).toBe(18);
  expect(b.total.connects).toBe(b.applications.connects + b.boosts.connects);

  const res = await handleApi(new Request('https://local.invalid/api/account-stats?range=custom&from=2026-11-01&to=2026-11-10'), e, '/api/account-stats');
  expect(res.status).toBe(200);
  const body = await res.json() as { stats: { boosts: { connects: number }; source: string }; phase: string };
  expect(body.phase).toBe('records');
  expect(body.stats.source).toBe('records');
  expect(body.stats.boosts.connects).toBe(308);
});
