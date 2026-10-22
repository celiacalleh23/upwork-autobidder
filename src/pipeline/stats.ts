import { putKv, getKv } from '../kv';
import type { McpClient } from '../mcp';
import { findKey, upworkClient } from '../oauth';
import { loadState, type Env } from '../settings';

// Rafa's Upwork account at a glance (on demand from the dashboard): proposals by status over the last 30 days, how many
// clients viewed them, contracts, completed jobs and Connects spent. Read-only, small pages, capped so one refresh stays
// well under the Workers subrequest limit; capped counts are shown as "N+".

export const WINDOWS = [30, 90, 365] as const;
const PAGES_PER_STATUS = 3; // 10 per page
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

async function countProposals(client: McpClient, tool: string, org: string, status: string, cutoff: number): Promise<Count & { viewed: number }> {
  let n = 0, viewed = 0, cursor: string | undefined;
  for (let page = 0; page < PAGES_PER_STATUS; page++) {
    const r = await client.callTool(tool, { action: 'list', org_uid: org, params: { status, limit: 10, sort_field: 'CREATEDDATETIME', sort_order: 'DESC', ...(cursor ? { cursor } : {}) } });
    const edges = findKey(r, 'edges') ?? findKey(r, 'proposals') ?? [];
    const rows = Array.isArray(edges) ? edges.map((e) => findKey(e, 'node') ?? e) : [];
    // An empty page ends the list, even if Upwork still reports a next page (seen on Rafa's account, Oct 21).
    if (!rows.length) return { n, viewed, capped: false };
    let older = false;
    for (const row of rows) {
      const created = findKey(row, 'createdDateTime') ?? findKey(row, 'created');
      if (before(created, cutoff)) { older = true; break; }
      if (!Number.isFinite(parseWhen(created))) unreadable.n++;
      n++;
      if (findKey(row, 'viewedByClient') === true) viewed++;
    }
    const info = findKey(r, 'pageInfo') as { hasNextPage?: boolean; endCursor?: string } | undefined;
    if (older || !info?.hasNextPage || !info.endCursor) return { n, viewed, capped: false };
    cursor = info.endCursor;
  }
  return { n, viewed, capped: true };
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

export async function refreshAccountStats(env: Env, windowDays: number = WINDOWS[0]): Promise<AccountStats> {
  const days = (WINDOWS as readonly number[]).includes(windowDays) ? windowDays : WINDOWS[0];
  const state = await loadState(env);
  const org = state.upwork.orgUid;
  const tools = state.upwork.toolNames;
  if (!org || !tools.list_freelancer_proposals) throw new Error('Upwork is not connected.');
  const client = await upworkClient(env);
  const names = await client.listTools();
  const profileTool = names.find((n) => n === 'get_profile' || n.endsWith('__get_profile'));
  const contractsTool = names.find((n) => n === 'list_contracts' || n.endsWith('__list_contracts'));
  const cutoff = Date.now() - days * 86400_000;
  unreadable.n = 0;

  const profile = profileTool ? await client.callTool(profileTool, { action: 'get', org_uid: org }).catch(() => null) : null;
  const agg = findKey(profile, 'profileAggregates') as Record<string, unknown> | undefined;
  const proposals = {} as AccountStats['proposals'];
  for (const s of STATUSES) {
    proposals[s] = await countProposals(client, tools.list_freelancer_proposals, org, s, cutoff).catch(() => ({ n: 0, viewed: 0, capped: false }));
  }
  const contracts = contractsTool
    ? { active: await countContracts(client, contractsTool, org, 'ACTIVE').catch(() => ({ n: 0, capped: false })),
        closed: await countContracts(client, contractsTool, org, 'CLOSED').catch(() => ({ n: 0, capped: false })) }
    : { active: { n: 0, capped: false }, closed: { n: 0, capped: false } };
  const connects = profileTool ? await connectsHistory(client, profileTool, org, cutoff).catch(() => null) : null;

  const stats: AccountStats = {
    at: new Date().toISOString(),
    windowDays: days,
    profile: {
      title: String(findKey(findKey(profile, 'personalData'), 'title') ?? '').replace(/<\/?untrusted_participant_content>/g, '').trim(),
      totalJobs: num(agg?.totalJobs), fixedJobs: num(agg?.totalFixedJobs), hourlyJobs: num(agg?.totalHourlyJobs), feedbackCount: num(agg?.totalFeedback),
    },
    proposals,
    contracts,
    connects: connects ?? { balance: state.connectsBalance, applications: { n: 0, capped: false }, spent: 0, refunded: 0, received: 0 },
    unreadableDates: unreadable.n,
  };
  await putKv(env, 'account_stats', JSON.stringify(stats));
  return stats;
}

export async function loadAccountStats(env: Env): Promise<AccountStats | null> {
  const raw = await getKv(env, 'account_stats');
  try { return raw ? (JSON.parse(raw) as AccountStats) : null; } catch { return null; }
}
