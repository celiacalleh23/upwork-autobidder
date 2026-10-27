import { McpError, type McpClient } from '../mcp';
import { findKey } from '../oauth';
import type { State } from '../settings';
import { stripUntrusted } from './filters';
import type { Answer } from './letter';
import { readBoost, type BoostInfo } from './sendRules';

// Upwork proposal preview (manage_proposals create). Nothing is sent: a preview only becomes a proposal through
// confirm_preview, which only the sender calls. The first call may ask for more fields; retry once with the defaults.

export interface Preview {
  previewId: string;
  connectsCost: number | null;
  canApply: boolean | null;
  questions: string[];
  extra: Record<string, string>; // application_method / payment_mode / estimated_duration that Upwork asked for
  boost: BoostInfo | null;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const FIXED_DEFAULTS = { payment_mode: 'by_project', estimated_duration: 'less_than_1_month' } as const;

export async function createPreview(
  client: McpClient, state: State,
  p: { jobId: string; letter: string; bid: number; fixed: boolean; extra?: Record<string, string>; answers?: Answer[]; boostConnects?: number },
): Promise<Preview> {
  const tool = state.upwork.toolNames.manage_proposals;
  if (!tool) throw new McpError('Upwork proposal tool is missing. Press Check now under Settings → Upwork.');
  const extra: Record<string, string> = { ...(p.fixed ? FIXED_DEFAULTS : {}), ...(p.extra ?? {}) };
  for (let attempt = 0; attempt < 2; attempt++) {
    const params = { job_reference: p.jobId, cover_letter: p.letter, charged_amount: p.bid, ...extra, ...(p.answers?.length ? { answers: p.answers } : {}), ...(p.boostConnects ? { boost_connects: p.boostConnects } : {}) };
    let r: unknown;
    try { r = await client.callTool(tool, { action: 'create', org_uid: state.upwork.orgUid, params }); } catch (e) {
      if (attempt === 0 && /application_method|ai.?interview/i.test(errText(e))) { extra.application_method = 'cover_letter'; continue; }
      if (attempt === 0 && /payment_mode|estimated_duration/i.test(errText(e))) { Object.assign(extra, FIXED_DEFAULTS); continue; }
      throw e;
    }
    const previewId = findKey(r, 'preview_id');
    if (typeof previewId !== 'string' || !previewId) {
      const asText = JSON.stringify(r ?? '');
      if (attempt === 0 && /application_method|ai.?interview/i.test(asText)) { extra.application_method = 'cover_letter'; continue; }
      throw new McpError(`Upwork preview returned no preview id: ${asText.slice(0, 200)}`);
    }
    const raw = findKey(r, 'screening_questions') ?? findKey(r, 'questions');
    const questions = (Array.isArray(raw) ? raw : [])
      .map((q) => (typeof q === 'string' ? q : String((q as Record<string, unknown>)?.question ?? (q as Record<string, unknown>)?.text ?? '')))
      .map((q) => stripUntrusted(q)).filter(Boolean);
    const cost = Number(findKey(r, 'connects_cost'));
    const can = findKey(r, 'can_apply');
    return { previewId, connectsCost: Number.isFinite(cost) ? cost : null, canApply: typeof can === 'boolean' ? can : null, questions, extra, boost: readBoost(findKey(r, 'boost')) };
  }
  throw new McpError('Upwork preview kept asking for more details.');
}
