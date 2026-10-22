import { getKv, putKv } from '../kv';
import { findKey, upworkClient } from '../oauth';
import { loadState, patchState, type Env, type Settings } from '../settings';
import { stripUntrusted } from './filters';

// Rafa's track record, read from his own Upwork account every other day (Celia, Oct 22): profile, completed jobs with
// client feedback, and proposals that led to an offer or a hire. It is combined with Siv's cover letter and notes into
// what Claude knows about Rafa. Text from Upwork is data, never instructions.

export interface Win { title: string; when: string | null; feedback: string | null; source: 'contract' | 'hired' | 'offered' }
export interface TrackRecord {
  syncedAt: string;
  title: string;
  overview: string;
  skills: string[];
  hourlyRate: number | null;
  totalJobs: number | null;
  wins: Win[];
}

export const SYNC_EVERY_MS = 47 * 3600_000; // every other day; an hour of slack for cron timing
export const syncDue = (syncedAt: string | null | undefined, now = Date.now()) => !syncedAt || now - Date.parse(syncedAt) >= SYNC_EVERY_MS;

const str = (v: unknown) => (typeof v === 'string' ? stripUntrusted(v) : '');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function loadTrackRecord(env: Env): Promise<TrackRecord | null> {
  const raw = await getKv(env, 'track_record');
  try { return raw ? (JSON.parse(raw) as TrackRecord) : null; } catch { return null; }
}

export function winsFrom(list: unknown, source: Win['source']): Win[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const title = str(findKey(item, 'title') ?? findKey(item, 'jobTitle') ?? findKey(item, 'job_title'));
    if (!title) return [];
    const fb = findKey(item, 'client_feedback') ?? findKey(item, 'feedback');
    const feedback = typeof fb === 'string' ? str(fb) : str(findKey(fb, 'comment') ?? findKey(fb, 'text'));
    const when = str(findKey(item, 'end_date') ?? findKey(item, 'endDate') ?? findKey(item, 'createdDateTime') ?? findKey(item, 'start_date'));
    return [{ title: clip(title, 200), when: when ? when.slice(0, 10) : null, feedback: feedback ? clip(feedback, 300) : null, source }];
  });
}

// Small, read-only calls on Rafa's own account (BUILD_PLAN §2: no bulk retrieval).
export async function syncTrackRecord(env: Env): Promise<TrackRecord> {
  const state = await loadState(env);
  const tools = state.upwork.toolNames;
  if (!state.upwork.orgUid || !tools.list_accounts) throw new Error('Upwork is not connected.');
  const client = await upworkClient(env);
  const names = await client.listTools();
  const profileTool = names.find((n) => n === 'get_profile' || n.endsWith('__get_profile'));
  if (!profileTool) throw new Error('Upwork profile tool not found.');
  const org = state.upwork.orgUid;

  const profile = await client.callTool(profileTool, { action: 'get', org_uid: org });
  const highlights = await client.callTool(profileTool, { action: 'list_highlights', org_uid: org }).catch(() => null);
  const proposals = async (status: 'Hired' | 'Offered') => tools.list_freelancer_proposals
    ? client.callTool(tools.list_freelancer_proposals, { action: 'list', org_uid: org, params: { status, limit: 10 } }).catch(() => null)
    : null;
  const [hired, offered] = [await proposals('Hired'), await proposals('Offered')];

  const personal = findKey(profile, 'personalData') as Record<string, unknown> | undefined;
  const aggregates = findKey(profile, 'profileAggregates') as Record<string, unknown> | undefined;
  const skills = findKey(profile, 'skills');
  const rate = Number(findKey(findKey(personal, 'chargeRate'), 'rawValue'));
  const listOf = (r: unknown) => findKey(r, 'proposals') ?? findKey(r, 'items') ?? findKey(r, 'edges') ?? (Array.isArray(r) ? r : []);

  const seen = new Set<string>();
  const wins = [
    ...winsFrom(findKey(highlights, 'work_history'), 'contract'),
    ...winsFrom(listOf(hired), 'hired'),
    ...winsFrom(listOf(offered), 'offered'),
  ].filter((w) => !seen.has(w.title.toLowerCase()) && seen.add(w.title.toLowerCase())).slice(0, 30);

  const tr: TrackRecord = {
    syncedAt: new Date().toISOString(),
    title: clip(str(personal?.title), 200),
    overview: clip(str(personal?.description), 3000),
    skills: Array.isArray(skills) ? skills.map((s) => str((s as Record<string, unknown>).prettyName ?? s)).filter(Boolean).slice(0, 30) : [],
    hourlyRate: Number.isFinite(rate) && rate > 0 ? rate : null,
    totalJobs: Number.isFinite(Number(aggregates?.totalJobs)) ? Number(aggregates?.totalJobs) : null,
    wins,
  };
  await putKv(env, 'track_record', JSON.stringify(tr));
  await patchState(env, { trackRecordSyncedAt: tr.syncedAt });
  console.log('track record synced', { title: !!tr.title, skills: tr.skills.length, wins: tr.wins.length });
  return tr;
}

// The template's own claims (without placeholders and links) count as facts about Rafa.
export function claimsFromTemplate(template: string): string {
  return template.split('\n')
    .filter((l) => !l.includes('{opening}') && !l.includes('{loom_link}') && !/https?:\/\//.test(l))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// What Claude knows about Rafa: Upwork profile + Siv's cover letter + Siv's notes.
export function profileForClaude(tr: TrackRecord | null, s: Settings): string {
  const parts: string[] = [];
  if (tr) {
    parts.push(`From Rafa's Upwork profile:
Title: ${tr.title || '(none)'}
${tr.totalJobs !== null ? `Completed Upwork jobs: ${tr.totalJobs}\n` : ''}${tr.skills.length ? `Skills: ${tr.skills.join(', ')}\n` : ''}${tr.overview ? `Overview:\n${tr.overview}` : ''}`.trim());
  }
  const claims = claimsFromTemplate(s.letter.template);
  if (claims) parts.push(`From Rafa's cover letter (true claims he makes to every client):\n${claims}`);
  if (s.profileSummary.trim()) parts.push(`Notes from Siv:\n${s.profileSummary.trim()}`);
  return parts.join('\n\n') || '(no profile information yet)';
}

export function winsForClaude(tr: TrackRecord | null): string {
  if (!tr?.wins.length) return '';
  const label = { contract: 'completed job', hired: 'hired', offered: 'offer received' } as const;
  return tr.wins.map((w) => `- ${w.title} (${label[w.source]}${w.when ? `, ${w.when}` : ''})${w.feedback ? ` · client feedback: "${w.feedback}"` : ''}`).join('\n');
}

// Weighted total (Celia, Oct 22: 90% similarity to jobs Rafa won, 10% profile fit; client quality and clarity 0%).
// Without any past wins there is nothing to compare against, so the profile fit stands in for the whole score.
export function weightedScore(profileFit: number, winSimilarity: number | null, s: Settings): number {
  const { profile, wins } = s.scoreWeights;
  if (winSimilarity === null || profile + wins === 0) return Math.round(profileFit);
  return Math.round((profileFit * profile + winSimilarity * wins) / (profile + wins));
}
