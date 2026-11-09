import type { Env } from '../settings';
import { findKey } from '../oauth';

// The dashboard labels status `submitting` as "Sending". Once Upwork has returned a proposal id, that row is submitted.
// One statement sets the status, the time, and the id together so a crash cannot leave the id on a Sending row.
export async function markSubmitted(
  env: Env, id: number, submittedAt: string, proposalId: string, connects: number | null, boost: number | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE proposals SET status = 'submitted', submitted_at = ?, upwork_proposal_id = ?, connects = ?, boost_connects = ?, error = NULL WHERE id = ?`,
  ).bind(submittedAt, proposalId, connects, boost, id).run();
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
