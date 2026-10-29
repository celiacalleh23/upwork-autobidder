import { dayStartUtc } from '../api';
import { acquireLease, delKv, getKv, putKv, releaseLease } from '../kv';
import type { McpClient } from '../mcp';
import { findKey, upworkClient } from '../oauth';
import { loadState, type Env } from '../settings';
import { heldByUpwork, paced } from '../upworkPace';

// Rafa's Upwork account at a glance: proposals by status for a period, how many clients viewed them, contracts,
// completed jobs, and Connects spent by kind (proposals, proposal boosts, Profile Boost, Availability Badge; Siv, Oct 27).
// Read on demand from the dashboard and by itself twice a day (Celia, Oct 29), read-only, in small steps; capped counts
// are shown as "N+".

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
// Proposal pages read per step: Workers allow 50 outside calls per request on the free plan, and a proposals step makes
// no other Upwork calls. The dashboard keeps asking until every status is counted.
const PAGE_BUDGET = 25;
const MAX_PAGES_PER_STATUS = 100; // 1,000 proposals per status; beyond that the count shows "+"
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
    readSince?: string | null; // the stored history does not reach back to the period's start yet: read back to here
    syncedAt?: string | null;  // when the Connects history was last brought up to date
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

// Rafa's Connects history, kept in D1 (connects_ledger) so a refresh only reads what is new (Celia, Oct 29: the old
// full re-read was up to 25 get_profile calls a round and helped trip Upwork's limit). Newest first: the first walk reads
// the whole history (up to MAX_HISTORY_DAYS) a few slow pages per run; later walks stop at the first page holding a
// record already stored. Upwork transactions have no id, so a record is keyed by its time, type, amount, job and reason.
const MAX_HISTORY_DAYS = 400;
const LEDGER_STATE = 'ledger:sync';
export interface LedgerRow { key: string; at: string; type: 'spent' | 'refunded' | 'received' | 'other'; reason: string; jobId: string | null; jobTitle: string | null; amount: number; kind: SpendKind }
export interface LedgerSync { cursor: string | null; complete: boolean; syncedAt: string | null }

export function parseLedgerPage(r: unknown): { rows: LedgerRow[]; next: string | null; credits: Record<string, number> | null } {
  const rows: LedgerRow[] = [];
  const tx = findKey(r, 'transactions');
  for (const t of Array.isArray(tx) ? tx : []) {
    const ms = parseWhen(findKey(t, 'createdDateTime'));
    if (!Number.isFinite(ms)) continue;
    const at = new Date(ms).toISOString();
    const raw = String(findKey(t, 'transactionType') ?? '');
    const type = /spent/i.test(raw) ? 'spent' : /refund/i.test(raw) ? 'refunded' : /receiv|purchas|bought/i.test(raw) ? 'received' : 'other';
    const job = findKey(t, 'jobPost') as { jobId?: unknown; jobTitle?: unknown } | null | undefined;
    const jobId = job && typeof job === 'object' && job.jobId !== undefined ? String(job.jobId).slice(0, 60) : null;
    const reason = String(findKey(t, 'reason') ?? '').slice(0, 120);
    const amount = Math.abs(num(findKey(findKey(t, 'amount'), 'rawValue')) ?? 0);
    rows.push({
      key: `${at}|${type}|${amount}|${jobId ?? ''}|${reason}`, at, type, reason, jobId, amount,
      jobTitle: job && typeof job === 'object' && job.jobTitle !== undefined ? String(job.jobTitle).replace(/<\/?untrusted_participant_content>/g, '').trim().slice(0, 200) : null,
      kind: spendKind(reason, !!(job && typeof job === 'object')),
    });
  }
  const info = findKey(r, 'pageInfo') as { hasNextPage?: boolean; endCursor?: string } | undefined;
  const next = findKey(r, 'next_cursor') ?? (info?.hasNextPage ? info.endCursor : undefined);
  const more = findKey(r, 'hasMore') !== false && typeof next === 'string' && !!next && rows.length > 0;
  let credits: Record<string, number> | null = null;
  const pc = findKey(r, 'product_credits');
  if (pc && typeof pc === 'object') {
    credits = {};
    for (const [k, v] of Object.entries(pc)) {
      const c = num(typeof v === 'object' && v ? findKey(v, 'balance') ?? findKey(v, 'rawValue') ?? findKey(v, 'amount') : v);
      if (c !== null) credits[k] = c;
    }
  }
  return { rows, next: more ? (next as string) : null, credits };
}

export async function loadLedgerSync(env: Env): Promise<LedgerSync> {
  try { return { cursor: null, complete: false, syncedAt: null, ...JSON.parse((await getKv(env, LEDGER_STATE)) ?? '{}') }; } catch { return { cursor: null, complete: false, syncedAt: null }; }
}

// Reads up to `maxPages` pages at the slow pace. Returns caughtUp when the walk reached stored records or the end.
export async function syncLedger(env: Env, client: McpClient, tool: string, org: string, maxPages: number, now = Date.now()): Promise<{ pages: number; caughtUp: boolean; sync: LedgerSync }> {
  const st = await loadLedgerSync(env);
  let pages = 0;
  try {
    while (pages < maxPages) {
      const fromTop = st.cursor === null;
      const r = await paced(env, () => client.callTool(tool, { action: 'connects_balance', org_uid: org, params: { limit: 10, ...(st.cursor ? { cursor: st.cursor } : {}) } }));
      pages++;
      const page = parseLedgerPage(r);
      if (fromTop && page.credits) await putKv(env, 'ledger:adCredits', JSON.stringify(page.credits));
      let added = 0;
      if (page.rows.length) {
        const res = await env.DB.batch(page.rows.map((x) => env.DB.prepare(
          'INSERT OR IGNORE INTO connects_ledger (key, at, type, reason, job_id, job_title, amount, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(x.key, x.at, x.type, x.reason, x.jobId, x.jobTitle, x.amount, x.kind)));
        added = res.reduce((t, q) => t + (q.meta.changes ?? 0), 0);
      }
      const tooOld = page.rows.some((x) => Date.parse(x.at) < now - MAX_HISTORY_DAYS * 86400_000);
      const end = page.next === null || tooOld;
      // Once the whole history was read, a page with a stored record means the rest is stored too.
      if (end || (st.complete && added < page.rows.length)) {
        if (end) st.complete = true;
        st.cursor = null; st.syncedAt = new Date(now).toISOString();
        return { pages, caughtUp: true, sync: st };
      }
      st.cursor = page.next;
    }
    return { pages, caughtUp: false, sync: st };
  } finally {
    await putKv(env, LEDGER_STATE, JSON.stringify(st));
  }
}

// Connects in a period, from the stored history. Totals per kind; refunds are subtracted per kind on the dashboard.
export function summarizeLedger(rows: { kind: string; type: string; n: number; amt: number }[]) {
  const byKind = Object.fromEntries(SPEND_KINDS.map((k) => [k, { n: 0, spent: 0, refunded: 0 }])) as Record<SpendKind, Spend>;
  let received = 0;
  for (const r of rows) {
    const k = (SPEND_KINDS as readonly string[]).includes(r.kind) ? (r.kind as SpendKind) : 'other';
    if (r.type === 'spent') { byKind[k].n += r.n; byKind[k].spent += r.amt; }
    else if (r.type === 'refunded') byKind[k].refunded += r.amt;
    else if (r.type === 'received') received += r.amt;
  }
  const kinds = Object.values(byKind);
  return { byKind, received, spent: kinds.reduce((t, k) => t + k.spent, 0), refunded: kinds.reduce((t, k) => t + k.refunded, 0) };
}

async function ledgerConnects(env: Env, from: number, to: number, balance: number | null): Promise<AccountStats['connects']> {
  const { results } = await env.DB.prepare(
    'SELECT kind, type, COUNT(*) AS n, SUM(amount) AS amt FROM connects_ledger WHERE at >= ? AND at < ? GROUP BY kind, type',
  ).bind(new Date(from).toISOString(), new Date(to).toISOString()).all<{ kind: string; type: string; n: number; amt: number }>();
  const sum = summarizeLedger(results);
  const sync = await loadLedgerSync(env);
  const oldest = (await env.DB.prepare('SELECT MIN(at) AS at FROM connects_ledger').first<{ at: string | null }>())?.at ?? null;
  // Still reading older history: the period may reach further back than what is stored.
  const partial = !sync.complete && (oldest === null || Date.parse(oldest) > from);
  let adCredits: Record<string, number> = {};
  try { adCredits = JSON.parse((await getKv(env, 'ledger:adCredits')) ?? '{}'); } catch { /* none */ }
  return {
    balance, applications: { n: sum.byKind.applications.n, capped: partial }, spent: sum.spent, refunded: sum.refunded, received: sum.received,
    byKind: sum.byKind, adCredits, readSince: partial ? oldest : null, syncedAt: sync.syncedAt,
  };
}

type Head = Omit<AccountStats, 'proposals' | 'unreadableDates' | 'connects' | 'at'>;
type Phase = 'head' | 'ledger' | 'statuses';
interface Progress {
  rangeId: string; cutoff: number; until: number; startedAt: number; phase: Phase; head: Head | null; ledgerPages: number;
  idx: number; cursor: string | null; statusPages: number; cur: { n: number; viewed: number };
  proposals: Partial<AccountStats['proposals']>; unreadable: number;
}
const ZERO = { n: 0, viewed: 0, capped: false };
// Manual refreshes (dashboard) and the twice-a-day refresh (upkeep cron) keep separate progress.
const PROGRESS = { manual: { key: 'account_stats_progress', ttl: 15 * 60_000 }, auto: { key: 'account_stats_progress:auto', ttl: 3 * 3600_000 } };
const MANUAL_LEDGER_PAGES = 6; // a manual refresh waits for at most this much new history; older history fills in by itself

const emptyHead = (range: Range): Head => ({
  windowDays: Math.max(1, Math.ceil((range.to - range.from) / 86400_000)),
  range: { key: range.key, label: range.label, from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
  profile: { title: '', totalJobs: null, fixedJobs: null, hourlyJobs: null, feedbackCount: null },
  contracts: { active: { n: 0, capped: false }, closed: { n: 0, capped: false } },
  boosters: null,
});

// One step of a refresh; the caller repeats it (resume) until done. Steps: the profile, contracts and boosters; new
// Connects history; then proposals by status (list_freelancer_proposals, not one of Upwork's slow tools, PAGE_BUDGET
// pages a step). Calls to get_profile and boost_profile take the slow shared pace (upworkPace.ts).
export async function refreshAccountStats(env: Env, range: Range, resume = false, slot: 'manual' | 'auto' = 'manual'): Promise<{ stats: AccountStats; done: boolean; phase: Phase }> {
  const state = await loadState(env);
  const org = state.upwork.orgUid;
  const tools = state.upwork.toolNames;
  if (!org || !tools.list_freelancer_proposals) throw new Error('Upwork is not connected.');
  if (heldByUpwork(state)) throw new Error('Paused: Upwork restricted or warned the account. Nothing is read from Upwork until bidding is resumed.');
  const client = await upworkClient(env);
  const { key, ttl } = PROGRESS[slot];

  let prog: Progress | null = null;
  if (resume) {
    try { prog = JSON.parse((await getKv(env, key)) ?? 'null'); } catch { prog = null; }
    if (prog && (prog.rangeId !== range.id || !prog.phase || Date.now() - prog.startedAt > ttl)) prog = null;
  }
  prog ??= { rangeId: range.id, cutoff: range.from, until: range.to, startedAt: Date.now(), phase: 'head', head: null, ledgerPages: 0, idx: 0, cursor: null, statusPages: 0, cur: { n: 0, viewed: 0 }, proposals: {}, unreadable: 0 };
  const names = prog.phase !== 'statuses' ? await client.listTools() : [];
  const tool = (base: string) => names.find((n) => n === base || n.endsWith(`__${base}`));

  if (prog.phase === 'head') {
    const profileTool = tool('get_profile'), contractsTool = tool('list_contracts'), boostTool = tool('boost_profile');
    const profile = profileTool ? await paced(env, () => client.callTool(profileTool, { action: 'get', org_uid: org })).catch(() => null) : null;
    const agg = findKey(profile, 'profileAggregates') as Record<string, unknown> | undefined;
    const contracts = contractsTool
      ? { active: await countContracts(client, contractsTool, org, 'ACTIVE').catch(() => ({ n: 0, capped: false })),
          closed: await countContracts(client, contractsTool, org, 'CLOSED').catch(() => ({ n: 0, capped: false })) }
      : { active: { n: 0, capped: false }, closed: { n: 0, capped: false } };
    // get_status only reads the badge and the ad; this tool's other actions are never called.
    const boosters = boostTool ? await paced(env, () => client.callTool(boostTool, { action: 'get_status', org_uid: org })).then(readBoosters, () => null) : null;
    prog.head = {
      ...emptyHead(range),
      profile: {
        title: String(findKey(findKey(profile, 'personalData'), 'title') ?? '').replace(/<\/?untrusted_participant_content>/g, '').trim(),
        totalJobs: num(agg?.totalJobs), fixedJobs: num(agg?.totalFixedJobs), hourlyJobs: num(agg?.totalHourlyJobs), feedbackCount: num(agg?.totalFeedback),
      },
      contracts, boosters,
    };
    prog.phase = 'ledger';
  } else if (prog.phase === 'ledger') {
    const profileTool = tool('get_profile');
    let next = true;
    // Another run (the background catch-up) holding the history lease is reading it already.
    if (profileTool && await acquireLease(env, 'ledger', 5 * 60_000)) {
      try {
        const r = await syncLedger(env, client, profileTool, org, 3);
        prog.ledgerPages += r.pages;
        next = r.caughtUp || !r.sync.complete || prog.ledgerPages >= MANUAL_LEDGER_PAGES;
      } catch { next = true; } finally { await releaseLease(env, 'ledger'); }
    }
    if (next) prog.phase = 'statuses';
  } else {
    unreadable.n = prog.unreadable;
    let budget = PAGE_BUDGET;
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
  }

  const done = prog.phase === 'statuses' && prog.idx >= STATUSES.length;
  const proposals = Object.fromEntries(STATUSES.map((s, k) => [s,
    prog!.proposals[s] ?? (k === prog!.idx ? { ...prog!.cur, capped: false } : ZERO)])) as AccountStats['proposals'];
  const stats: AccountStats = {
    ...(prog.head ?? emptyHead(range)), at: new Date().toISOString(), proposals, unreadableDates: prog.unreadable,
    connects: await ledgerConnects(env, prog.cutoff, prog.until, state.connectsBalance),
  };
  if (done) {
    await putKv(env, 'account_stats', JSON.stringify(stats));
    await delKv(env, key);
  } else {
    await putKv(env, key, JSON.stringify(prog));
  }
  return { stats, done, phase: prog.phase };
}

// Upkeep cron (every 5 minutes): Rafa's account refreshes by itself twice a day (Celia, Oct 29), one step per run, and
// the Connects history catches up on its first read, two slow pages per run. Nothing here touches bidding.
const AUTO_EVERY_MS = 12 * 3600_000;
export async function accountUpkeep(env: Env, tz: string, now = Date.now()): Promise<void> {
  const state = await loadState(env);
  if (!state.upwork.connected || !state.upwork.orgUid || !state.upwork.toolNames.list_freelancer_proposals || heldByUpwork(state)) return;
  const sync = await loadLedgerSync(env);
  if (!sync.complete || sync.cursor !== null) {
    if (await acquireLease(env, 'ledger', 5 * 60_000)) {
      try {
        const client = await upworkClient(env);
        const names = await client.listTools();
        const profileTool = names.find((n) => n === 'get_profile' || n.endsWith('__get_profile'));
        if (profileTool) await syncLedger(env, client, profileTool, state.upwork.orgUid, 2, now);
      } finally { await releaseLease(env, 'ledger'); }
    }
    return; // one Upwork task per upkeep run
  }
  const last = Number(await getKv(env, 'account_stats:autoAt')) || 0;
  if (now - last < AUTO_EVERY_MS) return;
  const r = await refreshAccountStats(env, resolveRange({ range: '30' }, tz, now), true, 'auto');
  if (r.done) await putKv(env, 'account_stats:autoAt', String(now));
}

export async function loadAccountStats(env: Env): Promise<AccountStats | null> {
  const raw = await getKv(env, 'account_stats');
  try { return raw ? (JSON.parse(raw) as AccountStats) : null; } catch { return null; }
}
