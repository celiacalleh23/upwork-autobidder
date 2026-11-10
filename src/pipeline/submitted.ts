import { delKv, getKv, putKv } from '../kv';
import type { Env } from '../settings';
import { findKey } from '../oauth';

// A send that dies before a preview is retried this many times, then returned to the review queue.
export const PREVIEW_STALL_RETRIES = 2;
export const STALL_NOTE = 'The send stopped before it reached Upwork.';

const stallKey = (id: number) => `send:stall:${id}`;

interface StallMark { open: boolean; n: number }

async function readStall(env: Env, id: number): Promise<StallMark | null> {
  const raw = await getKv(env, stallKey(id));
  if (!raw) return null;
  try {
    const mark = JSON.parse(raw) as StallMark;
    return mark && typeof mark.n === 'number' ? { open: !!mark.open, n: mark.n } : null;
  } catch { return null; }
}

// Remember that this attempt has started and has not stored a preview yet. A hard cancel leaves the mark in place.
export async function markStallOpen(env: Env, id: number): Promise<void> {
  const prev = await readStall(env, id);
  await putKv(env, stallKey(id), JSON.stringify({ open: true, n: prev?.n ?? 0 }));
}

export async function clearStall(env: Env, id: number): Promise<void> {
  await delKv(env, stallKey(id));
}

// The dashboard labels status `submitting` as "Sending". Once Upwork has returned a proposal id, that row is submitted.
// One statement sets the status, the time, and the id together so a crash cannot leave the id on a Sending row.
export async function markSubmitted(
  env: Env, id: number, submittedAt: string, proposalId: string, connects: number | null, boost: number | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE proposals SET status = 'submitted', submitted_at = ?, upwork_proposal_id = ?, connects = ?, boost_connects = ?, error = NULL WHERE id = ?`,
  ).bind(submittedAt, proposalId, connects, boost, id).run();
}

// A cut-off before a preview did not reach Upwork. Retry it, still approved, up to PREVIEW_STALL_RETRIES times.
// A stored preview is left alone: that attempt may have reached Upwork, so it is not submitted again here.
export async function requeueNeverConfirmed(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, status, preview_id, upwork_proposal_id FROM proposals
     WHERE (upwork_proposal_id IS NULL OR length(trim(upwork_proposal_id)) = 0)
       AND (
         (preview_id IS NULL AND approved_at IS NOT NULL AND (
           status = 'submitting'
           OR (status = 'unknown' AND error LIKE 'Interrupted while sending%')
           OR (status = 'failed' AND error = 'Manually checked on Upwork: not sent. No automatic retry.')
           OR status = 'approved'
         ))
         OR (preview_id IS NOT NULL AND status = 'approved')
       )`,
  ).all<{ id: number; status: string; preview_id: string | null; upwork_proposal_id: string | null }>();
  for (const row of results) {
    if (row.preview_id) { await clearStall(env, row.id); continue; }
    const mark = await readStall(env, row.id);
    const cutOff = row.status !== 'approved' || !!mark?.open;
    if (!cutOff) continue;
    const seen = (mark?.n ?? 0) + 1;
    if (seen > PREVIEW_STALL_RETRIES) {
      await env.DB.prepare(
        `UPDATE proposals SET status = 'pending', submitted_at = NULL, approved_at = NULL, approved_via = NULL, error = ? WHERE id = ? AND preview_id IS NULL`,
      ).bind(STALL_NOTE, row.id).run();
      await clearStall(env, row.id);
      continue;
    }
    await env.DB.prepare(
      `UPDATE proposals SET status = 'approved', submitted_at = NULL, error = NULL WHERE id = ? AND preview_id IS NULL AND (upwork_proposal_id IS NULL OR length(trim(upwork_proposal_id)) = 0)`,
    ).bind(row.id).run();
    await putKv(env, stallKey(row.id), JSON.stringify({ open: false, n: seen }));
  }
}

// Any Sending row that already has an Upwork proposal id is submitted. Runs before the sweeper that turns a stale
// `submitting` row into `unknown`, and again when the activity log is read.
export async function recoverSubmittedRows(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE proposals SET status = 'submitted', submitted_at = COALESCE(submitted_at, datetime('now')), error = NULL
     WHERE status IN ('submitting', 'sending')
       AND upwork_proposal_id IS NOT NULL AND length(trim(upwork_proposal_id)) > 0`,
  ).run();
}

// The id Upwork returned, wherever it sits in the confirm payload. Its presence means the proposal was accepted.
export function confirmProposalId(r: unknown): string | null {
  const created = findKey(r, 'createJobProposal') as Record<string, unknown> | undefined;
  const id = created?.newProposalId ?? findKey(r, 'newProposalId') ?? findKey(r, 'proposal_id') ?? findKey(r, 'proposalId');
  if (id === undefined || id === null || String(id).trim() === '') return null;
  return String(id);
}
