import type { Env } from '../settings';
import { loadSettings } from '../settings';

// Upwork sells Connects at $0.15 (Oct 2026). Same figure as the daily report and the dashboard.
export const CONNECT_USD = 0.15;

export interface ConnectsLine { charges: number; connects: number }

export interface ConnectsWindow {
  from: string;
  to: string;
  proposals: ConnectsLine;
  boosts: ConnectsLine;
  auctionDeposits: ConnectsLine;
  refunds: ConnectsLine;
  received: ConnectsLine;
  total: ConnectsLine;
}

export interface MonthConnectsReport extends ConnectsWindow {
  month: string;
  timeZone: string;
  today: ConnectsWindow;
}

export interface ReportProposal { connects: number | null; boostConnects: number | null }
export interface ReportLedger { type: string; reason: string; amount: number }

const auction = (reason: string) => /auction|sponsored proposal/i.test(reason);

// Proposals and boost bids come from the proposals we submitted. Refunds, Connects received, and
// auction deposits come from the Connects history already stored. A boost bid is what we placed;
// Upwork may deposit and later refund only part of it, so those two numbers are not forced to match.
export function buildMonthConnects(proposals: ReportProposal[], ledger: ReportLedger[]): Omit<ConnectsWindow, 'from' | 'to'> {
  const connects = proposals.reduce((t, p) => t + (Number(p.connects) || 0), 0);
  const boosted = proposals.filter((p) => (Number(p.boostConnects) || 0) > 0);
  const boosts = boosted.reduce((t, p) => t + (Number(p.boostConnects) || 0), 0);
  const deposits = ledger.filter((r) => r.type === 'spent' && auction(r.reason));
  const refunds = ledger.filter((r) => r.type === 'refunded');
  const received = ledger.filter((r) => r.type === 'received');
  const refundConnects = refunds.reduce((t, r) => t + (Number(r.amount) || 0), 0);
  const line = (charges: number, connects: number): ConnectsLine => ({ charges, connects });
  return {
    proposals: line(proposals.length, connects),
    boosts: line(boosted.length, boosts),
    auctionDeposits: line(deposits.length, deposits.reduce((t, r) => t + (Number(r.amount) || 0), 0)),
    refunds: line(refunds.length, refundConnects),
    received: line(received.length, received.reduce((t, r) => t + (Number(r.amount) || 0), 0)),
    total: line(proposals.length + boosted.length, connects + boosts - refundConnects),
  };
}

// Start of the calendar day in `timeZone`, as a UTC D1 timestamp. Same boundary for the
// "Connects spent today" card and the table's Today row.
export function dayStartUtc(timeZone: string, now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  const target = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  let candidate = target;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(candidate)).map((x) => [x.type, x.value]));
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const next = candidate + target - local;
    if (next === candidate) break;
    candidate = next;
  }
  return new Date(candidate).toISOString().slice(0, 19).replace('T', ' ');
}

// Start of the current calendar month in `timeZone`, as a UTC D1 timestamp.
export function monthStartUtc(timeZone: string, now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  const target = Date.UTC(+parts.year, +parts.month - 1, 1);
  let candidate = target;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(candidate)).map((x) => [x.type, x.value]));
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const next = candidate + target - local;
    if (next === candidate) break;
    candidate = next;
  }
  return new Date(candidate).toISOString().slice(0, 19).replace('T', ' ');
}

interface WindowRows { connects: number; boost_connects: number }
interface LedgerRows { type: string; reason: string; amount: number }

// One query shape for every period. The month table and today's card both call this.
export async function loadConnectsWindow(env: Env, from: string, to: string, toIso: string): Promise<ConnectsWindow> {
  const fromIso = `${from.replace(' ', 'T')}Z`;
  const [props, ledger] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COALESCE(connects, 0) AS connects, COALESCE(boost_connects, 0) AS boost_connects
       FROM proposals WHERE status = 'submitted' AND is_example = 0 AND submitted_at >= ? AND submitted_at < ?`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT type, reason, amount FROM connects_ledger WHERE at >= ? AND at < ?`,
    ).bind(fromIso, toIso),
  ]);
  const proposals = (props.results ?? []) as WindowRows[];
  const rows = (ledger.results ?? []) as LedgerRows[];
  return {
    from, to,
    ...buildMonthConnects(
      proposals.map((p) => ({ connects: p.connects, boostConnects: p.boost_connects })),
      rows,
    ),
  };
}

export async function loadTodayConnects(env: Env, now = new Date()): Promise<ConnectsWindow> {
  const settings = await loadSettings(env);
  const to = now.toISOString().slice(0, 19).replace('T', ' ');
  return loadConnectsWindow(env, dayStartUtc(settings.caps.timezone, now), to, now.toISOString());
}

export async function loadMonthConnects(env: Env, now = new Date()): Promise<MonthConnectsReport> {
  const settings = await loadSettings(env);
  const timeZone = settings.caps.timezone;
  const from = monthStartUtc(timeZone, now);
  const todayFrom = dayStartUtc(timeZone, now);
  const to = now.toISOString().slice(0, 19).replace('T', ' ');
  const toIso = now.toISOString();
  const [month, today] = await Promise.all([
    loadConnectsWindow(env, from, to, toIso),
    loadConnectsWindow(env, todayFrom, to, toIso),
  ]);
  const label = new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', year: 'numeric' }).format(now);
  return { month: label, timeZone, ...month, today };
}
