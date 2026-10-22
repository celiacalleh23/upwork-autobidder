import { putKv, getKv } from '../kv';
import type { McpClient } from '../mcp';
import { findKey, upworkClient } from '../oauth';
import { loadState, type Env } from '../settings';

// Rafa's Upwork account at a glance (on demand from the dashboard): proposals by status over the last 30 days, how many
// clients viewed them, contracts, completed jobs and Connects spent. Read-only, small pages, capped so one refresh stays
// well under the Workers subrequest limit; capped counts are shown as "N+".

const WINDOW_DAYS = 30;
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
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
const since = (iso: unknown, cutoff: number) => typeof iso === 'string' && Date.parse(iso) >= cutoff;

async function countProposals(client: McpClient, tool: string, org: string, status: string, cutoff: number): Promise<Count & { viewed: number }> {
  let n = 0, viewed = 0, cursor: string | undefined;
  for (let page = 0; page < PAGES_PER_STATUS; page++) {
    const r = await client.callTool(tool, { action: 'list', org_uid: org, params: { status, limit: 10, sort_field: 'CREATEDDATETIME', sort_order: 'DESC', ...(cursor ? { cursor } : {}) } });
    const edges = findKey(r, 'edges') ?? findKey(r, 'proposals') ?? [];
    const rows = Array.isArray(edges) ? edges.map((e) => findKey(e, 'node') ?? e) : [];
    let older = false;
    for (const row of rows) {
      const created = findKey(row, 'createdDateTime') ?? findKey(row, 'created');
      if (created !== undefined && !since(created, cutoff)) { older = true; break; }
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
      if (!since(findKey(t, 'createdDateTime'), cutoff)) { older = true; break; }
      const amount = num(findKey(findKey(t, 'amount'), 'rawValue')) ?? 0;
      const type = String(findKey(t, 'transactionType') ?? '');
      if (/spent/i.test(type)) { out.spent += -amount > 0 ? -amount : amount; if (/application/i.test(String(findKey(t, 'reason') ?? ''))) out.applications.n++; }
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

export async function refreshAccountStats(env: Env): Promise<AccountStats> {
  const state = await loadState(env);
  const org = state.upwork.orgUid;
  const tools = state.upwork.toolNames;
  if (!org || !tools.list_freelancer_proposals) throw new Error('Upwork is not connected.');
  const client = await upworkClient(env);
  const names = await client.listTools();
  const profileTool = names.find((n) => n === 'get_profile' || n.endsWith('__get_profile'));
  const contractsTool = names.find((n) => n === 'list_contracts' || n.endsWith('__list_contracts'));
  const cutoff = Date.now() - WINDOW_DAYS * 86400_000;

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
    windowDays: WINDOW_DAYS,
    profile: {
      title: String(findKey(findKey(profile, 'personalData'), 'title') ?? '').replace(/<\/?untrusted_participant_content>/g, '').trim(),
      totalJobs: num(agg?.totalJobs), fixedJobs: num(agg?.totalFixedJobs), hourlyJobs: num(agg?.totalHourlyJobs), feedbackCount: num(agg?.totalFeedback),
    },
    proposals,
    contracts,
    connects: connects ?? { balance: state.connectsBalance, applications: { n: 0, capped: false }, spent: 0, refunded: 0, received: 0 },
  };
  await putKv(env, 'account_stats', JSON.stringify(stats));
  return stats;
}

export async function loadAccountStats(env: Env): Promise<AccountStats | null> {
  const raw = await getKv(env, 'account_stats');
  try { return raw ? (JSON.parse(raw) as AccountStats) : null; } catch { return null; }
}
