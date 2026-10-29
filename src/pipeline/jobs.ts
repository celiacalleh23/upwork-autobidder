import type { Env, Settings } from '../settings';
import { containsTerm, recheckStored, reopenable, stripUntrusted, type StoredJob } from './filters';

// Jobs come in by link (Oct 30): Upwork restricted search on Rafa's account "due to violations of our Terms of
// Service", so this Worker no longer searches Upwork at all. A job is added from the dashboard ("Add a job") or by
// POST /api/jobs/intake with INTAKE_SECRET, and waits as 'matched'. The writer then reads that one job by id
// (find_jobs get, not a search), fills in its title, type, budget and country, applies the filters and drafts the
// proposal, which waits in the Review queue (or is approved in Auto-submit).

export const ADDED_REASON = 'Added by link';
export const MAX_ADDED_PER_HOUR = 30; // a feed gone wrong must not run up Claude and Loom costs

// The numeric job id from an Upwork job link (…/jobs/~02<id>, …/jobs/Some-title_~02<id>/, …/apply/…_~02<id>/) or a
// bare numeric id. Null for anything that is not an Upwork job.
export function jobIdFromUrl(input: string): string | null {
  const s = input.trim();
  if (/^\d{15,22}$/.test(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || !/(^|\.)upwork\.com$/.test(u.hostname)) return null;
  const m = /~0[12](\d{15,22})(?:[/?#]|$)/.exec(u.pathname + '/');
  return m ? m[1] : null;
}

export const jobUrl = (id: string) => `https://www.upwork.com/jobs/~02${id}`;

export type AddResult =
  | { ok: true; id: string; status: 'added' | 'requeued' }
  | { ok: false; id: string | null; reason: string };

// Adds a job for the writer. A job already proposed is left alone; one filtered, scored low or failed before comes back
// (someone chose it on purpose). `title` is a placeholder until the writer reads the job.
export async function addJob(env: Env, input: { jobUrl?: unknown; title?: unknown }): Promise<AddResult> {
  const id = jobIdFromUrl(String(input.jobUrl ?? ''));
  if (!id) return { ok: false, id: null, reason: 'Paste an Upwork job link (https://www.upwork.com/jobs/…).' };
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE reason = ? AND seen_at >= datetime('now', '-1 hour')")
    .bind(ADDED_REASON).first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_ADDED_PER_HOUR) return { ok: false, id, reason: `At most ${MAX_ADDED_PER_HOUR} jobs an hour; try again later.` };
  const title = stripUntrusted(String(input.title ?? '')).replace(/\s+/g, ' ').trim().slice(0, 300) || 'Job added by link';
  const existing = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(id).first<{ status: string }>();
  if (existing) {
    if (existing.status === 'proposed') return { ok: false, id, reason: 'A proposal for this job is already in the queue or the log.' };
    if (existing.status === 'matched') return { ok: false, id, reason: 'This job is already waiting to be written.' };
    await env.DB.prepare("UPDATE jobs SET status = 'matched', reason = ?, seen_at = datetime('now') WHERE id = ?").bind(ADDED_REASON, id).run();
    return { ok: true, id, status: 'requeued' };
  }
  await env.DB.prepare("INSERT INTO jobs (id, title, url, status, reason) VALUES (?, ?, ?, 'matched', ?)").bind(id, title, jobUrl(id), ADDED_REASON).run();
  return { ok: true, id, status: 'added' };
}

// Jobs still waiting as 'matched' are re-checked against the current settings, so a filter changed after they were
// added applies to them too; recent jobs dropped by a filter that no longer applies come back. Jobs added by link and
// not read yet are skipped: their type, budget and country are only known once the writer reads them.
export async function recheckMatched(env: Env, s: Settings): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, title, job_type, budget, client_country FROM jobs WHERE status = 'matched' AND reason IS NOT ? LIMIT 500",
  ).bind(ADDED_REASON).all<StoredJob & { id: string }>();
  const updates = results.flatMap((j) => {
    const reason = recheckStored(j, s);
    return reason ? [env.DB.prepare("UPDATE jobs SET status = 'filtered', reason = ? WHERE id = ? AND status = 'matched'").bind(`${reason} (settings changed)`, j.id)] : [];
  });
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
