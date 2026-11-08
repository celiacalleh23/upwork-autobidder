import { acquireLease, releaseLease } from '../kv';
import type { Env, Settings } from '../settings';
import { containsTerm, recheckStored, reopenable, stripUntrusted, type StoredJob } from './filters';
import { loadSnapshot, persistSnapshot } from './snapshot';

// Jobs arrive by manual link, Upwork discovery, or Apify. Automatic sources share canonical
// deduplication and the intake cap; the writer fetches full details and applies current filters.

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
  | { ok: false; id: string | null; reason: string; retryable?: boolean };

// Adds a job for the writer. A job already proposed is left alone; one filtered, scored low or failed before comes back
// (someone chose it on purpose). `title` is a placeholder until the writer reads the job.
export async function addJob(env: Env, input: {
  jobUrl?: unknown; title?: unknown; postedAt?: unknown; automatic?: boolean;
  description?: unknown; descriptionKind?: unknown; jobType?: unknown; budget?: unknown; proposalsTier?: unknown;
  client?: unknown; skills?: unknown;
}): Promise<AddResult> {
  const id = jobIdFromUrl(String(input.jobUrl ?? ''));
  if (!id) return { ok: false, id: null, reason: 'Paste an Upwork job link (https://www.upwork.com/jobs/…).' };
  const lease = await acquireLease(env, 'intake', 30_000);
  if (!lease) return { ok: false, id, reason: 'Intake is busy; retry shortly.', retryable: true };
  try {
    const existing = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(id).first<{ status: string }>();
    if (existing && (input.automatic || ['proposed', 'matched'].includes(existing.status))) {
      return { ok: false, id, reason: existing.status === 'proposed' ? 'A proposal for this job is already in the queue or the log.' : 'This job was already imported; its existing outcome is preserved.' };
    }
    if (await env.DB.prepare('SELECT 1 FROM proposals WHERE job_id = ?').bind(id).first()) return { ok: false, id, reason: 'A proposal for this job already exists.' };
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'intake:accepted:%' AND updated_at >= datetime('now', '-1 hour')").first<{ n: number }>();
    const count = recent?.n ?? 0;
    const key = `intake:accepted:${crypto.randomUUID()}`;
    if (count >= MAX_ADDED_PER_HOUR) return { ok: false, id, reason: `At most ${MAX_ADDED_PER_HOUR} jobs an hour; retry later.`, retryable: true };
    const title = stripUntrusted(String(input.title ?? '')).replace(/\s+/g, ' ').trim().slice(0, 300) || 'Job added by link';
    const date = typeof input.postedAt === 'string' ? Date.parse(input.postedAt) : NaN;
    const posted = Number.isFinite(date) && date <= Date.now() + 300_000 ? new Date(date).toISOString() : null;
    // Fill only gaps. A thin link or search hit must not erase a richer Apify snapshot already stored.
    const raw: Record<string, unknown> = { url: jobUrl(id), title: input.title, date_posted: posted };
    if (typeof input.description === 'string' && input.description.trim()) {
      raw.description = input.description;
      if (input.descriptionKind === 'fragment' || input.descriptionKind === 'body') raw.description_kind = input.descriptionKind;
    }
    if (typeof input.jobType === 'string' && input.jobType.trim()) raw.job_type = input.jobType;
    if (typeof input.budget === 'string' && input.budget.trim()) raw.budget = input.budget;
    if (typeof input.proposalsTier === 'string' && input.proposalsTier.trim()) raw.proposals_tier = input.proposalsTier;
    if (input.client && typeof input.client === 'object' && !Array.isArray(input.client)) raw.client = input.client;
    if (Array.isArray(input.skills)) raw.skills = input.skills;
    await persistSnapshot(env, {
      jobId: id, source: input.automatic ? 'automatic' : 'manual', partial: true,
      raw,
      provenance: { source: input.automatic ? 'automatic' : 'manual' },
    });
    // Pasting the link is the explicit retry. It re-reads the saved public payload and does not run on a cron import.
    if (!input.automatic) {
      const saved = await loadSnapshot(env, id);
      if (saved?.rawPayload) {
        try {
          const stored = JSON.parse(saved.rawPayload) as unknown;
          if (stored && typeof stored === 'object') {
            await persistSnapshot(env, {
              jobId: id, source: saved.source, partial: false, raw: stored,
              contract: env.APIFY_PROVIDER === 'hyperbach' ? 'hyperbach-public-upwork' : null,
              provenance: { source: 'manual-retry' },
            });
          }
        } catch { /* a damaged saved payload stays as it was */ }
      }
    }
    const change = existing
      ? env.DB.prepare("UPDATE jobs SET status = 'matched', reason = ? WHERE id = ? AND status NOT IN ('matched', 'proposed')").bind(ADDED_REASON, id)
      : env.DB.prepare("INSERT OR IGNORE INTO jobs (id, title, url, status, reason, posted_at) VALUES (?, ?, ?, 'matched', ?, ?)").bind(id, title, jobUrl(id), ADDED_REASON, posted);
    await env.DB.batch([change, env.DB.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(key, id)]);
    return { ok: true, id, status: existing ? 'requeued' : 'added' };
  } finally { await releaseLease(env, 'intake', lease); }
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
