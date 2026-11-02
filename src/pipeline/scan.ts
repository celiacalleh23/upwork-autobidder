import { acquireLease, getKv, ownsLease, putKv, releaseLease } from '../kv';
import { findKey, scanConnection, upworkClient, type UpworkPurpose } from '../oauth';
import { loadSettings, loadState, patchState, type Env } from '../settings';
import { addJob, jobUrl } from './jobs';

export const discoveryDue = (minute: number) => minute % 15 === 0;
export const DISCOVERY_WINDOW_MS = 60 * 60_000;
const MAX_QUERIES = 12; // 576 base requests/day; quota guard also counts retries.

export function discoveryJob(value: unknown, now = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const j = value as Record<string, unknown>;
  const id = String(j.id ?? '').replace(/^~02/, '');
  const date = j.published_date ?? j.created_date;
  const at = typeof date === 'string' ? Date.parse(date) : NaN;
  if (!/^\d{15,22}$/.test(id) || !Number.isFinite(at) || at > now + 300_000 || now - at > DISCOVERY_WINDOW_MS) return null;
  return { jobUrl: jobUrl(id), title: j.title, postedAt: new Date(at).toISOString(), automatic: true };
}

export async function runScan(env: Env, scheduledTime: number): Promise<void> {
  let failure: unknown;
  for (const purpose of ['bidding', 'scan'] as const) {
    if (purpose === 'scan' && env.EXTERNAL_SCAN_ONLY === 'true') continue;
    if (new Date(scheduledTime).getUTCMinutes() % 30 !== (purpose === 'scan' ? 15 : 0)) continue;
    try { await scanAccount(env, scheduledTime, purpose); } catch(e) { failure = e; }
  }
  if (failure) throw failure;
}

export async function scanAccount(env: Env, scheduledTime: number, purpose: UpworkPurpose, accept = addJob): Promise<void> {
  if (purpose === 'scan' && env.SCAN_ACCOUNT_DISABLED === 'true') return;
  const scope = purpose === 'scan' ? ':scan' : '';
  const key = (name: string) => `discovery:${name}${scope}`;
  const leaseName = `discovery${scope}`;
  const lease = await acquireLease(env, leaseName, 600_000);
  if (!lease) return;
  const slot = String(Math.floor(scheduledTime / 1800_000));
  try {
    const state = await loadState(env);
    if (purpose === 'scan') state.upwork = await scanConnection(env);
    if (state.paused || !state.upwork.connected || !state.upwork.orgUid || !state.upwork.toolNames.find_jobs) return;
    if (await getKv(env, key('slot')) === slot) return;
    const s = await loadSettings(env);
    if (!s.keywords.length) return;
    // Claim the slot before network activity: duplicate cron deliveries never repeat a billable scan.
    await putKv(env, key('slot'), slot);
    const start = Number(await getKv(env, key('keywordOffset')) ?? 0) % s.keywords.length;
    let imported = 0, queries = 0, truncated = 0;
    const record = async (error: string | null) => {
      const run = JSON.stringify({ at: new Date().toISOString(), source: 'Upwork', purpose, queries, imported, truncated, error });
      await env.DB.batch([key('lastScan'), `discovery:run:${purpose}:${slot}`].map(name =>
        env.DB.prepare("INSERT INTO kv(key,value,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(name, run)));
    };
    try {
      const client = await upworkClient(env, purpose);
      for (let i = 0; i < Math.min(MAX_QUERIES, s.keywords.length); i++) {
        if (!(await ownsLease(env, leaseName, lease)) || (await loadState(env)).paused) break;
        const keyword = s.keywords[(start + i) % s.keywords.length];
        const result = await client.callTool(state.upwork.toolNames.find_jobs, {
          action: 'search', org_uid: state.upwork.orgUid,
          params: { title: keyword, sort: 'recency', limit: 10, verified_payment_only: s.verifiedOnly, include_full_details: true },
        });
        queries++;
        const jobs = findKey(result, 'jobs');
        if (!Array.isArray(jobs) || jobs.length > 10) throw new Error('Unexpected Upwork search results; discovery stopped.');
        if (jobs.length === 10) truncated++;
        for (const raw of jobs) {
          if (!(await ownsLease(env, leaseName, lease)) || (await loadState(env)).paused) break;
          const job = discoveryJob(raw);
          if (!job) continue;
          const added = await accept(env, job);
          if (!added.ok && added.retryable) throw new Error(added.reason);
          if (added.ok) imported++;
        }
        await putKv(env, key('keywordOffset'), String((start + i + 1) % s.keywords.length));
      }
      if (purpose === 'bidding') await patchState(env, { lastScanAt: new Date().toISOString() });
      await record(null);
    } catch (e) {
      await record(e instanceof Error ? e.message : 'Discovery failed');
      throw e;
    }
  } finally { await releaseLease(env, leaseName, lease); }
}

export async function discoveryRunHistory(env: Env) {
  const { results } = await env.DB.prepare("SELECT value FROM kv WHERE key LIKE 'discovery:run:%' ORDER BY json_extract(value,'$.at') DESC, key DESC LIMIT 20").all<{ value: string }>();
  return results.map(row => JSON.parse(row.value));
}
