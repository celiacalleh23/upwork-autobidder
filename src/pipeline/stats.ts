import { dayStartUtc } from '../api';
import { delKv, getKv, putKv } from '../kv';
import type { McpClient } from '../mcp';
import { findKey, upworkClient } from '../oauth';
import { loadState, type Env } from '../settings';

// Rafa's Upwork account at a glance (on demand from the dashboard): proposals by status over the last 30 days, how many
// clients viewed them, contracts, completed jobs, and Connects spent by kind (proposals, proposal boosts, Profile Boost,
// Availability Badge; Siv, Oct 27). Read-only, small pages, capped so one refresh stays well under the Workers
// subrequest limit; capped counts are shown as "N+".

// The period to read (Celia, Oct 29: today, yesterday, last 7 days and a custom range besides 30 / 90 / 365 days).
// Calendar days follow the Settings time zone. `to` is exclusive.
export const RANGES = ['today', 'yesterday', '7', '30', '90', '365', 'custom'] as const;
export type RangeKey = (typeof RANGES)[number];
export interface Range { key: RangeKey; id: string; from: number; to: number; label: string }
export const MAX_CUSTOM_DAYS = 400;

const sqlMs = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);
// Local midnight of a YYYY-MM-DD date (noon UTC falls on that date in every zone from -12 h to +11 h).
const midnight = (tz: string, ymd: string) => sqlMs(dayStartUtc(tz, new Date(`${ymd}T12:00:00Z`)));
const ymdIn = (tz: string, ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const nextYmd = (ymd: string) => new Date(Date.parse(`${ymd}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);

export function resolveRange(input: { range?: unknown; days?: unknown; from?: unknown; to?: unknown }, tz: string, now = Date.now()): Range {
  const key = String(input.range ?? input.days ?? '30') as RangeKey;
  if (!(RANGES as readonly string[]).includes(key)) throw new RangeError('Unknown period');
  const today = ymdIn(tz, now);
  const startToday = midnight(tz, today);
  if (key === 'today') return { key, id: key, from: startToday, to: now, label: 'Today' };
  if (key === 'yesterday') return { key, id: key, from: midnight(tz, ymdIn(tz, startToday - 12 * 3600_000)), to: startToday, label: 'Yesterday' };
  if (key !== 'custom') {
    const days = Number(key);
    return { key, id: key, from: now - days * 86400_000, to: now, label: days === 365 ? 'Last 12 months' : `Last ${days} days` };
  }
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  const from = String(input.from ?? ''), to = String(input.to ?? '');
  if (!ymd.test(from) || !ymd.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new RangeError('Pick a start and an end date');
  if (from > to) throw new RangeError('The start date is after the end date');
  if (from > today) throw new RangeError('The start date is in the future');
  const end = to >= today ? now : midnight(tz, nextYmd(to));
  const start = midnight(tz, from);
  if (end - start > MAX_CUSTOM_DAYS * 86400_000) throw new RangeError(`Pick at most ${MAX_CUSTOM_DAYS} days`);
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return { key, id: `custom:${from}:${to}`, from: start, to: end, label: from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}` };
}
// Proposal pages read per request: Workers allow 50 outside calls per request on the free plan, and the profile,
// contracts and Connects history use about 12. The dashboard keeps asking until every status is counted.
const PAGE_BUDGET = 25;
const MAX_PAGES_PER_STATUS = 100; // 1,000 proposals per status; beyond that the count shows "+"
const MAX_CONNECTS_PAGES = 300;  // 3,000 Connects transactions (about 3 months of daily bidding); beyond that "read in part"
const STATUSES = ['Accepted', 'Pending', 'Declined', 'Withdrawn', 'Archived', 'Offered', 'Hired', 'Activated'] as const;

export interface Count { n: number; capped: boolean }
export interface AccountStats {
  at: string;
  windowDays: number; // the period in days, rounded up
  range?: { key: RangeKey; label: string; from: string; to: string }; // absent in figures read before Oct 29
  profile: { title: string; totalJobs: number | null; fixedJobs: number | null; hourlyJobs: number | null; feedbackCount: number | null };
  proposals: Record<(typeof STATUSES)[number], Count & { viewed: number }>;
  contracts: { active: Count; closed: Count };
  connects: {
    balance: number | null; applications: Count; spent: number; refunded: number; received: number;
    byKind: Record<SpendKind, Spend>; // what the Connects were spent on (refunds subtracted per kind)
    adCredits: Record<string, number>; // Upwork product credits (ads), kept apart from the Connects balance
  };
  boosters: Boosters | null; // Availability Badge and Profile Boost as they stand now
  unreadableDates: number; // proposals whose date could not be read (counted as inside the period)
}

export const SPEND_KINDS = ['applications', 'proposalBoosts', 'profileBoost', 'badge', 'other'] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];
export interface Spend { n: number; spent: number; refunded: number }

// What a Connects transaction paid for, from Upwork's reason text and whether it is tied to a job. Seen on a real
// account (Oct 27): "Job application" and "Refund job cancellation" with a jobPost. The wording for boosts and the badge
// is not confirmed yet, so the patterns are broad and anything unrecognised is counted as "other", never dropped.
export function spendKind(reason: string, hasJob: boolean): SpendKind {
  const r = reason.toLowerCase();
  const boost = /boost|\bbid\b/.test(r);
  // Tied to a job: the application or its boost (a refund "job no longer available" must not read as the badge).
  if (hasJob || /proposal/.test(r)) return boost ? 'proposalBoosts' : 'applications';
  if (/availab|badge|\bpib\b/.test(r)) return 'badge';
  if (boost || /\bads?\b|advert|promot|spotlight/.test(r)) return 'profileBoost';
  if (/appl/.test(r)) return 'applications';
  return 'other';
}

export interface Boosters {
  badge: { active: boolean; price: number | null; renewsAt: string | null } | null;
  profileBoost: { status: string; bid: number | null } | null;
}

// boost_profile get_status (read-only): pib_details.pibStatus is the Availability Badge, boost_status the Profile Boost ad.
export function readBoosters(r: unknown): Boosters {
  const n = (v: unknown) => (v === null || v === undefined || v === '' ? null : num(typeof v === 'object' ? findKey(v, 'rawValue') ?? findKey(v, 'amount') : v));
  const pib = findKey(r, 'pibStatus') as Record<string, unknown> | undefined;
  const ad = findKey(r, 'boost_status');
  return {
    badge: pib && typeof pib === 'object'
      ? { active: pib.active === true || String(pib.status ?? '').toUpperCase() === 'ON', price: n(pib.currentPrice), renewsAt: typeof pib.nextRenewalAt === 'string' ? pib.nextRenewalAt : null }
      : null,
    profileBoost: ad && typeof ad === 'object'
      ? { status: String(findKey(ad, 'status') ?? findKey(ad, 'adStatus') ?? 'unknown'), bid: n(findKey(ad, 'bid') ?? findKey(ad, 'bidAmount') ?? findKey(ad, 'connectsBid')) }
      : null,
  };
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
// Upwork dates come as ISO text, epoch numbers (s or ms) or objects like {rawValue}; NaN when unreadable.
export function parseWhen(v: unknown, depth = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    if (/^\d{10,13}$/.test(v.trim())) return parseWhen(Number(v), depth);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : NaN;
  }
  if (v && typeof v === 'object' && depth < 3) {
    for (const k of ['rawValue', 'value', 'displayValue', 'dateTime', 'date']) {
      const t = parseWhen((v as Record<string, unknown>)[k], depth + 1);
      if (Number.isFinite(t)) return t;
    }
  }
  return NaN;
}
// Unreadable dates count as inside the window, so a format change can only over-count, never hide proposals.
const before = (v: unknown, cutoff: number) => { const t = parseWhen(v); return Number.isFinite(t) && t < cutoff; };

const unreadable = { n: 0 };

// Reads one status a page at a time, from `cursor`, for at most `budget` pages. Upwork returns 10 per page, so a full
// count can take several requests; the caller keeps the cursor between them.
interface PageRun { n: number; viewed: number; pages: number; done: boolean; cursor: string | null }
export async function readProposalPages(client: McpClient, tool: string, org: string, status: string, cutoff: number, cursor: string | null, budget: number, until = Infinity): Promise<PageRun> {
  let n = 0, viewed = 0, pages = 0;
  while (pages < budget) {
    const r = await client.callTool(tool, { action: 'list', org_uid: org, params: { status, limit: 10, sort_field: 'CREATEDDATETIME', sort_order: 'DESC', ...(cursor ? { cursor } : {}) } });
    pages++;
    const edges = findKey(r, 'edges') ?? findKey(r, 'proposals') ?? [];
    const rows = Array.isArray(edges) ? edges.map((e) => findKey(e, 'node') ?? e) : [];
    // An empty page ends the list, even if Upwork still reports a next page (seen on Rafa's account, Oct 21).
    if (!rows.length) return { n, viewed, pages, done: true, cursor: null };
    let older = false;
    for (const row of rows) {
      const created = findKey(row, 'createdDateTime') ?? findKey(row, 'created');
      if (before(created, cutoff)) { older = true; break; }
      if (parseWhen(created) >= until) continue; // newer than the period (e.g. yesterday's figures read today)
      if (!Number.isFinite(parseWhen(created))) unreadable.n++;
      n++;
      if (findKey(row, 'viewedByClient') === true) viewed++;
    }
    const info = findKey(r, 'pageInfo') as { hasNextPage?: boolean; endCursor?: string } | undefined;
    if (older || !info?.hasNextPage || !info.endCursor) return { n, viewed, pages, done: true, cursor: null };
    cursor = info.endCursor;
  }
  return { n, viewed, pages, done: false, cursor };
}

async function countContracts(client: McpClient, tool: string, org: string, status: 'ACTIVE' | 'CLOSED'): Promise<Count> {
  let n = 0;
  for (let page = 0; page < 2; page++) {
    const r = await client.callTool(tool, { action: 'search', org_uid: org, params: { contract_statuses: [status], limit: 10, offset: page * 10 } });
    const rows = findKey(r, 'edges') ?? findKey(r, 'contracts') ?? findKey(r, 'items') ?? [];
    const got = Array.isArray(rows) ? rows.length : 0;
    n += got;
    if (got < 10 || findKey(r, 'hasMore') === false) return { n, capped: false };
  }
  return { n, capped: true };
}

// Rafa's Connects history, a page (10 transactions) at a time from `run.cursor`, for at most `budget` pages, newest first;
// stops at the first transaction older than the period. The caller keeps `run` between requests.
export interface ConnectsRun {
  cursor: string | null; pages: number; done: boolean; capped: boolean;
  balance: number | null; received: number; byKind: Record<SpendKind, Spend>; adCredits: Record<string, number>;
}
export const newConnectsRun = (): ConnectsRun => ({
  cursor: null, pages: 0, done: false, capped: false, balance: null, received: 0, adCredits: {},
  byKind: Object.fromEntries(SPEND_KINDS.map((k) => [k, { n: 0, spent: 0, refunded: 0 }])) as Record<SpendKind, Spend>,
});

export async function readConnectsPages(client: McpClient, tool: string, org: string, cutoff: number, run: ConnectsRun, budget: number, until = Infinity): Promise<number> {
  let used = 0;
  while (!run.done && used < budget) {
    const r = await client.callTool(tool, { action: 'connects_balance', org_uid: org, params: { limit: 10, ...(run.cursor ? { cursor: run.cursor } : {}) } });
    used++; run.pages++;
    if (run.balance === null) run.balance = num(findKey(findKey(r, 'balance'), 'connectsBalance'));
    const credits = findKey(r, 'product_credits');
    if (run.pages === 1 && credits && typeof credits === 'object') {
      for (const [k, v] of Object.entries(credits)) {
        const c = num(typeof v === 'object' && v ? findKey(v, 'balance') ?? findKey(v, 'rawValue') ?? findKey(v, 'amount') : v);
        if (c !== null) run.adCredits[k] = c;
      }
    }
    const tx = findKey(r, 'transactions');
    let older = false;
    for (const t of Array.isArray(tx) ? tx : []) {
      if (before(findKey(t, 'createdDateTime'), cutoff)) { older = true; break; }
      if (parseWhen(findKey(t, 'createdDateTime')) >= until) continue;
      const amount = Math.abs(num(findKey(findKey(t, 'amount'), 'rawValue')) ?? 0);
      const type = String(findKey(t, 'transactionType') ?? '');
      const job = findKey(t, 'jobPost');
      const kind = spendKind(String(findKey(t, 'reason') ?? ''), !!job && typeof job === 'object');
      if (/spent/i.test(type)) { run.byKind[kind].spent += amount; run.byKind[kind].n++; }
      else if (/refund/i.test(type)) run.byKind[kind].refunded += amount;
      else if (/receiv|purchas|bought/i.test(type)) run.received += amount;
    }
    const info = findKey(r, 'pageInfo') as { hasNextPage?: boolean; endCursor?: string } | undefined;
    const next = findKey(r, 'next_cursor') ?? (info?.hasNextPage ? info.endCursor : undefined);
    if (older || findKey(r, 'hasMore') === false || typeof next !== 'string' || !next) { run.done = true; run.cursor = null; }
    else if (run.pages >= MAX_CONNECTS_PAGES) { run.done = true; run.capped = true; run.cursor = null; }
    else run.cursor = next;
  }
  return used;
}

function connectsSummary(run: ConnectsRun, fallbackBalance: number | null): AccountStats['connects'] {
  const kinds = Object.values(run.byKind);
  return {
    balance: run.balance ?? fallbackBalance,
    applications: { n: run.byKind.applications.n, capped: run.capped || !run.done },
    spent: kinds.reduce((t, k) => t + k.spent, 0),
    refunded: kinds.reduce((t, k) => t + k.refunded, 0),
    received: run.received,
    byKind: run.byKind,
    adCredits: run.adCredits,
  };
}

type Head = Omit<AccountStats, 'proposals' | 'unreadableDates' | 'connects'>;
interface Progress {
  rangeId: string; cutoff: number; until: number; startedAt: number; head: Head; balance: number | null;
  connectsTool: string | null; cx: ConnectsRun;
  idx: number; cursor: string | null; statusPages: number; cur: { n: number; viewed: number };
  proposals: Partial<AccountStats['proposals']>; unreadable: number;
}
const PROGRESS_KEY = 'account_stats_progress';
const PROGRESS_TTL_MS = 15 * 60_000;
const ZERO = { n: 0, viewed: 0, capped: false };

// Counts Rafa's proposals exactly, over as many requests as it takes: each call reads up to PAGE_BUDGET pages and
// returns done:false with the figures so far until every status is counted. `resume` continues an unfinished count.
export async function refreshAccountStats(env: Env, range: Range, resume = false): Promise<{ stats: AccountStats; done: boolean }> {
  const state = await loadState(env);
  const org = state.upwork.orgUid;
  const tools = state.upwork.toolNames;
  if (!org || !tools.list_freelancer_proposals) throw new Error('Upwork is not connected.');
  const client = await upworkClient(env);

  let prog: Progress | null = null;
  if (resume) {
    try { prog = JSON.parse((await getKv(env, PROGRESS_KEY)) ?? 'null'); } catch { prog = null; }
    if (prog && (prog.rangeId !== range.id || !prog.cx || Date.now() - prog.startedAt > PROGRESS_TTL_MS)) prog = null;
  }
  if (!prog) {
    const names = await client.listTools();
    const profileTool = names.find((n) => n === 'get_profile' || n.endsWith('__get_profile'));
    const contractsTool = names.find((n) => n === 'list_contracts' || n.endsWith('__list_contracts'));
    const boostTool = names.find((n) => n === 'boost_profile' || n.endsWith('__boost_profile'));
    const profile = profileTool ? await client.callTool(profileTool, { action: 'get', org_uid: org }).catch(() => null) : null;
    const agg = findKey(profile, 'profileAggregates') as Record<string, unknown> | undefined;
    const contracts = contractsTool
      ? { active: await countContracts(client, contractsTool, org, 'ACTIVE').catch(() => ({ n: 0, capped: false })),
          closed: await countContracts(client, contractsTool, org, 'CLOSED').catch(() => ({ n: 0, capped: false })) }
      : { active: { n: 0, capped: false }, closed: { n: 0, capped: false } };
    // get_status only reads the badge and the ad; this tool's other actions are never called.
    const boosters = boostTool ? await client.callTool(boostTool, { action: 'get_status', org_uid: org }).then(readBoosters, () => null) : null;
    prog = {
      rangeId: range.id, cutoff: range.from, until: range.to, startedAt: Date.now(), idx: 0, cursor: null, statusPages: 0, cur: { n: 0, viewed: 0 }, proposals: {}, unreadable: 0,
      balance: state.connectsBalance, connectsTool: profileTool ?? null, cx: newConnectsRun(),
      head: {
        at: '', windowDays: Math.max(1, Math.ceil((range.to - range.from) / 86400_000)),
        range: { key: range.key, label: range.label, from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
        profile: {
          title: String(findKey(findKey(profile, 'personalData'), 'title') ?? '').replace(/<\/?untrusted_participant_content>/g, '').trim(),
          totalJobs: num(agg?.totalJobs), fixedJobs: num(agg?.totalFixedJobs), hourlyJobs: num(agg?.totalHourlyJobs), feedbackCount: num(agg?.totalFeedback),
        },
        contracts,
        boosters,
      },
    };
  }

  unreadable.n = prog.unreadable;
  let budget = PAGE_BUDGET;
  // The Connects history first, then the proposals by status; both resume where the last request stopped.
  if (!prog.cx.done) {
    if (!prog.connectsTool) prog.cx.done = true;
    else {
      const startPages = prog.cx.pages;
      budget -= await readConnectsPages(client, prog.connectsTool, org, prog.cutoff, prog.cx, budget, prog.until)
        .catch(() => { prog!.cx.done = true; prog!.cx.capped = true; return prog!.cx.pages - startPages + 1; });
    }
  }
  while (prog.idx < STATUSES.length && budget > 0) {
    const status = STATUSES[prog.idx];
    const run = await readProposalPages(client, tools.list_freelancer_proposals, org, status, prog.cutoff, prog.cursor, Math.min(budget, MAX_PAGES_PER_STATUS - prog.statusPages), prog.until)
      .catch(() => ({ n: 0, viewed: 0, pages: 1, done: true, cursor: null } as PageRun));
    budget -= run.pages;
    prog.statusPages += run.pages;
    prog.cur = { n: prog.cur.n + run.n, viewed: prog.cur.viewed + run.viewed };
    const capped = !run.done && prog.statusPages >= MAX_PAGES_PER_STATUS;
    if (run.done || capped) {
      prog.proposals[status] = { ...prog.cur, capped };
      Object.assign(prog, { idx: prog.idx + 1, cursor: null, statusPages: 0, cur: { n: 0, viewed: 0 } });
    } else prog.cursor = run.cursor;
  }
  prog.unreadable = unreadable.n;

  const done = prog.idx >= STATUSES.length && prog.cx.done;
  const proposals = Object.fromEntries(STATUSES.map((s, k) => [s,
    prog!.proposals[s] ?? (k === prog!.idx ? { ...prog!.cur, capped: false } : ZERO)])) as AccountStats['proposals'];
  const stats: AccountStats = { ...prog.head, connects: connectsSummary(prog.cx, prog.balance), at: new Date().toISOString(), proposals, unreadableDates: prog.unreadable };
  if (done) {
    await putKv(env, 'account_stats', JSON.stringify(stats));
    await delKv(env, PROGRESS_KEY);
  } else {
    await putKv(env, PROGRESS_KEY, JSON.stringify(prog));
  }
  return { stats, done };
}

export async function loadAccountStats(env: Env): Promise<AccountStats | null> {
  const raw = await getKv(env, 'account_stats');
  try { return raw ? (JSON.parse(raw) as AccountStats) : null; } catch { return null; }
}
