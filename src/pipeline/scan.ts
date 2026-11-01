import { acquireLease, getKv, ownsLease, putKv, releaseLease } from '../kv';
import { findKey, upworkClient } from '../oauth';
import { loadSettings, loadState, patchState, type Env } from '../settings';
import { addJob, jobUrl } from './jobs';

export const discoveryDue = (minute: number) => minute === 0 || minute === 30;
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
  const lease = await acquireLease(env, 'discovery', 240_000);
  if (!lease) return;
  const slot = String(Math.floor(scheduledTime / 1800_000));
  try {
    const state = await loadState(env);
    if (state.paused || !state.upwork.connected || !state.upwork.orgUid || !state.upwork.toolNames.find_jobs) return;
    if (await getKv(env, 'discovery:slot') === slot) return;
    const s = await loadSettings(env);
    if (!s.keywords.length) return;
    // Claim the slot before network activity: duplicate cron deliveries never repeat a billable scan.
    await putKv(env, 'discovery:slot', slot);
    const client = await upworkClient(env);
    const start = Number(await getKv(env, 'discovery:keywordOffset') ?? 0) % s.keywords.length;
    let imported = 0, queries = 0, truncated = 0;
    try {
      for (let i = 0; i < Math.min(MAX_QUERIES, s.keywords.length); i++) {
        if (!(await ownsLease(env, 'discovery', lease)) || (await loadState(env)).paused) break;
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
          if (!(await ownsLease(env, 'discovery', lease)) || (await loadState(env)).paused) break;
          const job = discoveryJob(raw);
          if (!job) continue;
          const added = await addJob(env, job);
          if (!added.ok && added.retryable) throw new Error(added.reason);
          if (added.ok) imported++;
        }
        await putKv(env, 'discovery:keywordOffset', String((start + i + 1) % s.keywords.length));
      }
      await patchState(env, { lastScanAt: new Date().toISOString() });
      await putKv(env, 'discovery:lastScan', JSON.stringify({ at: new Date().toISOString(), queries, imported, truncated, error: null }));
    } catch (e) {
      await putKv(env, 'discovery:lastScan', JSON.stringify({ at: new Date().toISOString(), queries, imported, truncated, error: e instanceof Error ? e.message : 'Discovery failed' }));
      throw e;
    }
  } finally { await releaseLease(env, 'discovery', lease); }
}
