import { delKv, getKv, putKv } from '../kv';
import type { McpClient } from '../mcp';
import { findKey, upworkClient } from '../oauth';
import { loadState, type Env } from '../settings';

// Rafa's Upwork account at a glance (on demand from the dashboard): proposals by status over the last 30 days, how many
// clients viewed them, contracts, completed jobs and Connects spent. Read-only, small pages, capped so one refresh stays
// well under the Workers subrequest limit; capped counts are shown as "N+".

export const WINDOWS = [30, 90, 365] as const;
// Proposal pages read per request: Workers allow 50 outside calls per request on the free plan, and the profile,
// contracts and Connects history use about 12. The dashboard keeps asking until every status is counted.
const PAGE_BUDGET = 25;
const MAX_PAGES_PER_STATUS = 100; // 1,000 proposals per status; beyond that the count shows "+"
const STATUSES = ['Accepted', 'Pending', 'Declined', 'Withdrawn', 'Archived', 'Offered', 'Hired', 'Activated'] as const;

export interface Count { n: number; capped: boolean }
export interface AccountStats {
  at: string;
  windowDays: number;
  profile: { title: string; totalJobs: number | null; fixedJobs: number | null; hourlyJobs: number | null; feedbackCount: number | null };
  proposals: Record<(typeof STATUSES)[number], Count & { viewed: number }>;
  contracts: { active: Count; closed: Count };
  connects: { balance: number | null; applications: Count; spent: number; refunded: number; received: number };
  unreadableDates: number; // proposals whose date could not be read (counted as inside the period)
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
export async function readProposalPages(client: McpClient, tool: string, org: string, status: string, cutoff: number, cursor: string | null, budget: number): Promise<PageRun> {
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

async function connectsHistory(client: McpClient, tool: string, org: string, cutoff: number) {
  const out = { balance: null as number | null, applications: { n: 0, capped: false }, spent: 0, refunded: 0, received: 0 };
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await client.callTool(tool, { action: 'connects_balance', org_uid: org, params: { limit: 10, ...(cursor ? { cursor } : {}) } });
    if (out.balance === null) out.balance = num(findKey(findKey(r, 'balance'), 'connectsBalance'));
    const tx = findKey(r, 'transactions');
    let older = false;
    for (const t of Array.isArray(tx) ? tx : []) {
      if (before(findKey(t, 'createdDateTime'), cutoff)) { older = true; break; }
      const amount = num(findKey(findKey(t, 'amount'), 'rawValue')) ?? 0;
      const type = String(findKey(t, 'transactionType') ?? '');
      if (/spent/i.test(type)) {
        out.spent += Math.abs(amount);
        // Connects spent on a job are an application (or its boost), whatever wording Upwork uses for the reason.
        const job = findKey(t, 'jobPost');
        if ((job && typeof job === 'object') || /appl|proposal/i.test(String(findKey(t, 'reason') ?? ''))) out.applications.n++;
      }
      else if (/refund/i.test(type)) out.refunded += amount;
      else if (/receiv|purchas|bought/i.test(type)) out.received += amount;
    }
    const next = findKey(r, 'next_cursor');
    if (older || findKey(r, 'hasMore') === false || typeof next !== 'string') return out;
    cursor = next;
  }
  out.applications.capped = true;
  return out;
}

type Head = Omit<AccountStats, 'proposals' | 'unreadableDates'>;
interface Progress {
  days: number; cutoff: number; startedAt: number; head: Head;
  idx: number; cursor: string | null; statusPages: number; cur: { n: number; viewed: number };
  proposals: Partial<AccountStats['proposals']>; unreadable: number;
}
const PROGRESS_KEY = 'account_stats_progress';
const PROGRESS_TTL_MS = 15 * 60_000;
const ZERO = { n: 0, viewed: 0, capped: false };

// Counts Rafa's proposals exactly, over as many requests as it takes: each call reads up to PAGE_BUDGET pages and
// returns done:false with the figures so far until every status is counted. `resume` continues an unfinished count.
export async function refreshAccountStats(env: Env, windowDays: number = WINDOWS[0], resume = false): Promise<{ stats: AccountStats; done: boolean }> {
  const days = (WINDOWS as readonly number[]).includes(windowDays) ? windowDays : WINDOWS[0];
  const state = await loadState(env);
  const org = state.upwork.orgUid;
  const tools = state.upwork.toolNames;
  if (!org || !tools.list_freelancer_proposals) throw new Error('Upwork is not connected.');
  const client = await upworkClient(env);

  let prog: Progress | null = null;
  if (resume) {
    try { prog = JSON.parse((await getKv(env, PROGRESS_KEY)) ?? 'null'); } catch { prog = null; }
    if (prog && (prog.days !== days || Date.now() - prog.startedAt > PROGRESS_TTL_MS)) prog = null;
  }
  if (!prog) {
    const names = await client.listTools();
    const profileTool = names.find((n) => n === 'get_profile' || n.endsWith('__get_profile'));
    const contractsTool = names.find((n) => n === 'list_contracts' || n.endsWith('__list_contracts'));
    const cutoff = Date.now() - days * 86400_000;
    const profile = profileTool ? await client.callTool(profileTool, { action: 'get', org_uid: org }).catch(() => null) : null;
    const agg = findKey(profile, 'profileAggregates') as Record<string, unknown> | undefined;
    const contracts = contractsTool
      ? { active: await countContracts(client, contractsTool, org, 'ACTIVE').catch(() => ({ n: 0, capped: false })),
          closed: await countContracts(client, contractsTool, org, 'CLOSED').catch(() => ({ n: 0, capped: false })) }
      : { active: { n: 0, capped: false }, closed: { n: 0, capped: false } };
    const connects = profileTool ? await connectsHistory(client, profileTool, org, cutoff).catch(() => null) : null;
    prog = {
      days, cutoff, startedAt: Date.now(), idx: 0, cursor: null, statusPages: 0, cur: { n: 0, viewed: 0 }, proposals: {}, unreadable: 0,
      head: {
        at: '', windowDays: days,
        profile: {
          title: String(findKey(findKey(profile, 'personalData'), 'title') ?? '').replace(/<\/?untrusted_participant_content>/g, '').trim(),
          totalJobs: num(agg?.totalJobs), fixedJobs: num(agg?.totalFixedJobs), hourlyJobs: num(agg?.totalHourlyJobs), feedbackCount: num(agg?.totalFeedback),
        },
        contracts,
        connects: connects ?? { balance: state.connectsBalance, applications: { n: 0, capped: false }, spent: 0, refunded: 0, received: 0 },
      },
    };
  }

  unreadable.n = prog.unreadable;
  let budget = PAGE_BUDGET;
  while (prog.idx < STATUSES.length && budget > 0) {
    const status = STATUSES[prog.idx];
    const run = await readProposalPages(client, tools.list_freelancer_proposals, org, status, prog.cutoff, prog.cursor, Math.min(budget, MAX_PAGES_PER_STATUS - prog.statusPages))
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

  const done = prog.idx >= STATUSES.length;
  const proposals = Object.fromEntries(STATUSES.map((s, k) => [s,
    prog!.proposals[s] ?? (k === prog!.idx ? { ...prog!.cur, capped: false } : ZERO)])) as AccountStats['proposals'];
  const stats: AccountStats = { ...prog.head, at: new Date().toISOString(), proposals, unreadableDates: prog.unreadable };
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
