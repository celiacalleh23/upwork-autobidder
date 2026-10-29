import { acquireLease, getKv, putKv, releaseLease } from '../kv';
import { McpError, type McpClient } from '../mcp';
import { findKey, upworkClient } from '../oauth';
import { loadSettings, loadState, patchState, type Env, type RunSummary, type Settings } from '../settings';
import { scanEveryMinutes } from './pace';
import { skillsOf } from './trends';
import { containsTerm, evaluateJob, recheckStored, reopenable, stripUntrusted, type StoredJob, type UpworkJob } from './filters';

// Scanner: small, recent result pages per keyword, every new job recorded once with its filter verdict.
// Jobs that pass are stored as 'matched'; scoring and letters (M4) pick them up from there.

const KEYWORDS_PER_RUN = 5; // two searches each; keeps a run well under the Workers subrequest limit
const LEASE_MS = 4 * 60_000;

async function search(client: McpClient, tool: string, orgUid: string, params: Record<string, unknown>): Promise<UpworkJob[]> {
  const r = await client.callTool(tool, { action: 'search', org_uid: orgUid, params: { sort: 'recency', limit: 10, ...params } });
  const jobs = findKey(r, 'jobs');
  return Array.isArray(jobs) ? (jobs as UpworkJob[]).filter((j) => j && typeof j.id === 'string' && /^\d+$/.test(j.id)) : [];
}

async function invitedJobIds(client: McpClient, tool: string | undefined, orgUid: string): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!tool) return ids;
  const r = await client.callTool(tool, { action: 'invitations', org_uid: orgUid, params: { status: 'pending', limit: 10 } });
  const list = findKey(r, 'invitations') ?? findKey(r, 'items') ?? findKey(r, 'edges');
  for (const inv of Array.isArray(list) ? list : []) {
    const id = findKey(inv, 'jobPosting') as { id?: unknown } | undefined;
    if (id?.id !== undefined) ids.add(String(id.id));
  }
  return ids;
}

// Rotates through the keywords when there are more than fit in one run.
async function keywordsForRun(env: Env, s: Settings): Promise<string[]> {
  if (s.keywords.length <= KEYWORDS_PER_RUN) return s.keywords;
  const start = Number(await getKv(env, 'scan_keyword_cursor')) || 0;
  const out = Array.from({ length: KEYWORDS_PER_RUN }, (_, i) => s.keywords[(start + i) % s.keywords.length]);
  await putKv(env, 'scan_keyword_cursor', String((start + KEYWORDS_PER_RUN) % s.keywords.length));
  return out;
}

// Jobs still waiting as 'matched' are re-checked against the current settings, so a filter changed after
// they were found (e.g. countries added) applies to them too. Returns how many were filtered out.
export async function recheckMatched(env: Env, s: Settings): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, title, job_type, budget, client_country FROM jobs WHERE status = 'matched' LIMIT 500",
  ).all<StoredJob & { id: string }>();
  const updates = results.flatMap((j) => {
    const reason = recheckStored(j, s);
    return reason ? [env.DB.prepare("UPDATE jobs SET status = 'filtered', reason = ? WHERE id = ? AND status = 'matched'").bind(`${reason} (settings changed)`, j.id)] : [];
  });
  // And the other way: recent jobs dropped by a filter that no longer applies come back as 'matched'.
  const { results: dropped } = await env.DB.prepare(
    "SELECT id, title, job_type, budget, client_country, reason FROM jobs WHERE status = 'filtered' AND seen_at >= datetime('now', '-48 hours') LIMIT 500",
  ).all<StoredJob & { id: string; reason: string | null }>();
  for (const j of dropped) {
    if (!reopenable(j.reason) || recheckStored(j, s)) continue;
    const inTitle = s.keywords.filter((k) => containsTerm(stripUntrusted(j.title), k));
    updates.push(env.DB.prepare("UPDATE jobs SET status = 'matched', reason = ? WHERE id = ? AND status = 'filtered'")
      .bind(`Matched: ${(inTitle.length ? inTitle : s.keywords).join(', ')}`, j.id));
  }
  if (updates.length) await env.DB.batch(updates);
  return updates.length;
}

export function scanDue(lastScanAt: string | null, everyMinutes: number, now = Date.now()): boolean {
  if (!lastScanAt) return true;
  // 30 s slack so a cron that fires a little early still counts as due.
  return now - Date.parse(lastScanAt) >= everyMinutes * 60_000 - 30_000;
}

export async function runScan(env: Env, opts: { force?: boolean } = {}): Promise<RunSummary | null> {
  const [state, settings] = await Promise.all([loadState(env), loadSettings(env)]);
  if (state.paused || !state.upwork.connected || !state.upwork.orgUid) return null;
  if (!opts.force && !scanDue(state.lastScanAt, scanEveryMinutes(state.mode, settings))) return null;
  if (!(await acquireLease(env, 'scan', LEASE_MS))) return null;

  const summary: RunSummary = { at: new Date().toISOString(), scanned: 0, new: 0, matched: 0, errors: 0, note: null };
  const run = await env.DB.prepare("INSERT INTO runs (started_at) VALUES (datetime('now')) RETURNING id").first<{ id: number }>();
  try {
    const tools = state.upwork.toolNames;
    const orgUid = state.upwork.orgUid;
    if (!tools.find_jobs) throw new McpError('Upwork tool names are missing. Press Check now under Settings → Upwork.');
    await recheckMatched(env, settings);
    const client = await upworkClient(env);
    const invited = await invitedJobIds(client, tools.list_freelancer_proposals, orgUid).catch((e) => {
      summary.errors++; summary.note = `Invitations not checked: ${e instanceof Error ? e.message : e}`;
      return new Set<string>();
    });

    const found = new Map<string, UpworkJob>();
    for (const kw of await keywordsForRun(env, settings)) {
      // Title search is exact; the broad query also covers descriptions (with full text, filtered literally afterwards).
      const batches = [search(client, tools.find_jobs, orgUid, { title: kw })];
      if (!settings.titleOnly) batches.push(search(client, tools.find_jobs, orgUid, { query: kw, include_full_details: true }));
      for (const jobs of await Promise.all(batches)) {
        for (const j of jobs) found.set(j.id, { ...found.get(j.id), ...j, description: j.description ?? found.get(j.id)?.description });
      }
    }
    summary.scanned = found.size;

    const ids = [...found.keys()];
    const seen = new Set<string>();
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const { results } = await env.DB.prepare(`SELECT id FROM jobs WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ id: string }>();
      results.forEach((r) => seen.add(r.id));
    }

    const inserts: D1PreparedStatement[] = [];
    for (const job of found.values()) {
      if (seen.has(job.id)) continue;
      const v = evaluateJob(job, settings, invited);
      summary.new++;
      if (v.status === 'matched') summary.matched++;
      inserts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO jobs (id, title, url, job_type, budget, client_country, posted_at, proposals_tier, status, reason, skills)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        job.id, stripUntrusted(job.title).slice(0, 300), job.url ?? null, job.job_type ?? null, job.budget ?? null,
        job.client?.country ?? null, job.published_date ?? job.created_date ?? null, job.proposals_tier ?? null,
        v.status, v.status === 'filtered' ? v.reason : `Matched: ${v.keywords.join(', ')}`,
        JSON.stringify(skillsOf(job.skills)),
      ));
    }
    if (inserts.length) await env.DB.batch(inserts);
  } catch (e) {
    summary.errors++;
    const msg = e instanceof Error ? e.message : String(e);
    summary.note = msg.slice(0, 300);
    console.error('scan failed', msg);
    // Plan §2: any rate limit from Upwork pauses everything until Siv resumes.
    if (/\b429\b|rate.?limit|too many requests/i.test(msg)) {
      await patchState(env, { paused: true, pausedReason: `Upwork rate limit during the job scan: ${msg.slice(0, 200)}` });
    }
  } finally {
    await env.DB.prepare(
      "UPDATE runs SET finished_at = datetime('now'), scanned = ?, new_jobs = ?, matched = ?, errors = ?, note = ? WHERE id = ?",
    ).bind(summary.scanned, summary.new, summary.matched, summary.errors, summary.note, run?.id ?? 0).run();
    await patchState(env, { lastScanAt: summary.at, lastRun: summary });
    await releaseLease(env, 'scan');
  }
  return summary;
}
