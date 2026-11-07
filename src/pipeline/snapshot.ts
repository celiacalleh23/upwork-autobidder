import { acquireLease, releaseLease } from '../kv';
import type { Env, Settings } from '../settings';
import { normalizeCountry, stripUntrusted } from './filters';
import { computeBid } from './letter';

const snapshotUrl = (id: string) => `https://www.upwork.com/jobs/~02${id}`;

// Public snapshot captured when a job is ingested. Nothing in the normalized object is an account fact:
// applied, can_apply, Connects balance, Connects cost, and boost stay null even if a feed includes them.

export const RAW_PAYLOAD_LIMIT = 100_000;
export const DESCRIPTION_STORE_LIMIT = 50_000;

export interface PublicJobSnapshot {
  v: 1;
  id: string;
  sourceId: string | null;
  title: string | null;
  url: string | null;
  description: string | null;
  descriptionTruncated: boolean;
  jobType: 'fixed' | 'hourly' | null;
  budgetText: string | null;
  currency: null;
  country: string | null;
  verification: string | null;
  proposalCount: number | null;
  proposalsTier: string | null;
  postedAt: string | null;
  skills: string[] | null;
  questions: string[] | null; // null = unknown, including a scraper empty list. A non-empty list is a hint only.
  questionHint: string | null;
  applied: null;
  canApply: null;
  connectsCost: null;
  connectsBalance: null;
  boost: null;
}

export interface SnapshotRow {
  jobId: string;
  source: string;
  fetchedAt: string;
  sourcePostedAt: string | null;
  sourceSeenAt: string | null;
  provenance: unknown;
  rawPayload: string;
  rawTruncated: boolean;
  rawOriginalBytes: number;
  normalized: PublicJobSnapshot;
}

interface PersistInput {
  jobId: string;
  source: string;
  raw: unknown;
  partial: boolean;
  provenance: Record<string, unknown>;
}

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
// Descriptions keep internal newlines. Titles and other short fields stay single-line.
const passage = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = stripUntrusted(v).trim();
  return s ? s.slice(0, max) : null;
};
const text = (v: unknown, max = 500): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = stripUntrusted(String(v)).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const iso = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const asNumber = (v: unknown): number | null => {
  if (typeof v === 'boolean' || v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function boundRawPayload(value: unknown): { json: string; truncated: boolean; originalBytes: number } {
  const full = JSON.stringify(value ?? null);
  const originalBytes = new TextEncoder().encode(full).length;
  if (full.length <= RAW_PAYLOAD_LIMIT) return { json: full, truncated: false, originalBytes };
  const note = `raw payload truncated at ${RAW_PAYLOAD_LIMIT} characters`;
  const src = object(value);
  const clipped: Record<string, unknown> = { _truncated: true, _originalBytes: originalBytes, _note: note };
  if (src) {
    for (const [key, entry] of Object.entries(src)) {
      if (typeof entry === 'string') clipped[key] = entry.slice(0, 2_000);
      else if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) clipped[key] = entry;
      else clipped[key] = '[omitted: nested value removed while truncating the raw payload]';
      if (JSON.stringify(clipped).length > RAW_PAYLOAD_LIMIT) {
        delete clipped[key];
        break;
      }
    }
  } else clipped.value = full.slice(0, 1_000);
  let json = JSON.stringify(clipped);
  if (json.length > RAW_PAYLOAD_LIMIT) json = JSON.stringify({ _truncated: true, _originalBytes: originalBytes, _note: note });
  return { json, truncated: true, originalBytes };
}

function questionList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const items = value.map((q) => text(typeof q === 'string' ? q : object(q)?.question ?? object(q)?.text, 1_000)).filter((q): q is string => !!q);
  return items.length ? items : null;
}

function moneyText(v: unknown): string | null {
  const n = asNumber(typeof v === 'object' ? object(v)?.rawValue ?? object(v)?.amount : v);
  return n !== null && n > 0 ? n.toFixed(2) : null;
}

function budgetText(raw: Record<string, unknown>, jobType: 'fixed' | 'hourly' | null): string | null {
  const direct = text(raw.budget ?? raw.budget_text ?? raw.budgetText, 120);
  if (direct) return direct;
  if (jobType === 'hourly') {
    const min = moneyText(raw.hourly_budget_min ?? raw.hourlyBudgetMin ?? raw.hourly_min);
    const max = moneyText(raw.hourly_budget_max ?? raw.hourlyBudgetMax ?? raw.hourly_max);
    if (min && max) return `${min}–${max}/hr`;
    if (max) return `up to ${max}/hr`;
    if (min) return `${min}+/hr`;
    const rate = moneyText(raw.price);
    return rate ? `${rate}/hr` : null;
  }
  const fixed = moneyText(raw.fixed_budget ?? raw.fixed_price ?? raw.amount ?? raw.fixedPrice ?? raw.price);
  return jobType === 'fixed' ? fixed : null;
}

function jobTypeOf(raw: Record<string, unknown>): 'fixed' | 'hourly' | null {
  const type = String(raw.price_type ?? raw.job_type ?? raw.jobType ?? raw.type ?? raw.contract_type ?? raw.contractType ?? '').toLowerCase();
  if (type.includes('hour')) return 'hourly';
  if (type.includes('fix')) return 'fixed';
  const budget = text(raw.budget ?? raw.budget_text, 120) ?? '';
  if (/\/hr\b/i.test(budget)) return 'hourly';
  return null;
}

function verificationOf(raw: Record<string, unknown>): string | null {
  const direct = text(raw.verification_status ?? raw.payment_verification, 40);
  if (direct) return direct.toUpperCase() === 'VERIFIED' ? 'VERIFIED' : direct.toUpperCase() === 'UNVERIFIED' ? 'UNVERIFIED' : direct;
  const flag = raw.buyer_payment_verified ?? raw.payment_verified ?? raw.paymentVerified;
  if (flag === true) return 'VERIFIED';
  if (flag === false) return 'UNVERIFIED';
  return null;
}

function countryOf(raw: Record<string, unknown>): string | null {
  const client = object(raw.client);
  const value = text(raw.country ?? raw.client_country ?? raw.client_location ?? raw.clientLocation ?? client?.country, 80);
  if (!value) return null;
  return normalizeCountry(value) ? value : null;
}

// Feed questions that are missing or an empty list stay unknown. AI-written fields are hints, not questions.
export function normalizePublicJob(jobId: string, raw: unknown): PublicJobSnapshot {
  const src = object(raw) ?? {};
  const descriptionSource = passage(src.description ?? src.description_text ?? src.job_description ?? src.description_snippet ?? src.snippet, DESCRIPTION_STORE_LIMIT + 1);
  const descriptionTruncated = !!descriptionSource && descriptionSource.length > DESCRIPTION_STORE_LIMIT;
  const description = descriptionSource ? descriptionSource.slice(0, DESCRIPTION_STORE_LIMIT) : null;
  const jobType = jobTypeOf(src);
  const skillsRaw = src.skills;
  const skills = Array.isArray(skillsRaw) ? skillsRaw.map((s) => text(typeof s === 'string' ? s : object(s)?.name, 80)).filter((s): s is string => !!s).slice(0, 40) : null;
  const hint = [text(src.ai_specific_requirements_before_applying, 500), text(src.ai_anti_bot_phrase, 200)].filter(Boolean).join(' · ') || null;
  const sourceId = text(src.id ?? src.job_id ?? src.jobId, 80);
  return {
    v: 1, id: jobId, sourceId, title: text(src.title ?? src.jobTitle, 300),
    url: text(typeof src.url === 'object' ? object(src.url)?.href ?? object(src.url)?.url : src.url ?? src.link ?? src.jobUrl, 400) ?? snapshotUrl(jobId),
    description, descriptionTruncated, jobType, budgetText: budgetText(src, jobType), currency: null,
    country: countryOf(src), verification: verificationOf(src),
    proposalCount: asNumber(src.proposal_count ?? src.proposalCount ?? src.applicants),
    proposalsTier: text(src.proposals_tier ?? src.proposalsTier, 40),
    postedAt: iso(src.date_posted ?? src.published_date ?? src.publishedDate ?? src.postedAt ?? src.posted_at),
    skills: skills?.length ? skills : null,
    questions: questionList(src.screening_questions ?? src.questions),
    questionHint: hint,
    applied: null, canApply: null, connectsCost: null, connectsBalance: null, boost: null,
  };
}

function longer(prev: string | null, next: string | null, partial: boolean, nextTruncated: boolean, prevTruncated: boolean): string | null {
  if (!next) return prev;
  if (!prev) return next;
  if (partial) return prev;
  if (nextTruncated && !prevTruncated) return prev;
  if (next.length < prev.length && nextTruncated) return prev;
  return next;
}

function descriptionFlag(prev: PublicJobSnapshot, next: PublicJobSnapshot, partial: boolean): boolean {
  const kept = longer(prev.description, next.description, partial, next.descriptionTruncated, prev.descriptionTruncated);
  if (kept === prev.description) return prev.descriptionTruncated;
  return next.descriptionTruncated;
}

export function mergeSnapshots(prev: PublicJobSnapshot | null, next: PublicJobSnapshot, partial: boolean): PublicJobSnapshot {
  if (!prev) return next;
  return {
    ...next,
    id: prev.id,
    sourceId: prev.sourceId ?? next.sourceId,
    title: partial ? (prev.title ?? next.title) : (next.title ?? prev.title),
    url: partial ? (prev.url ?? next.url) : (next.url ?? prev.url),
    description: longer(prev.description, next.description, partial, next.descriptionTruncated, prev.descriptionTruncated),
    descriptionTruncated: descriptionFlag(prev, next, partial),
    jobType: partial ? (prev.jobType ?? next.jobType) : (next.jobType ?? prev.jobType),
    budgetText: partial ? (prev.budgetText ?? next.budgetText) : (next.budgetText ?? prev.budgetText),
    currency: null,
    country: partial ? (prev.country ?? next.country) : (next.country ?? prev.country),
    verification: partial ? (prev.verification ?? next.verification) : (next.verification ?? prev.verification),
    proposalCount: partial ? (prev.proposalCount ?? next.proposalCount) : (next.proposalCount ?? prev.proposalCount),
    proposalsTier: partial ? (prev.proposalsTier ?? next.proposalsTier) : (next.proposalsTier ?? prev.proposalsTier),
    postedAt: partial ? (prev.postedAt ?? next.postedAt) : (next.postedAt ?? prev.postedAt),
    skills: partial ? (prev.skills ?? next.skills) : (next.skills ?? prev.skills),
    questions: next.questions?.length ? (partial && prev.questions?.length ? prev.questions : next.questions) : prev.questions,
    questionHint: partial ? (prev.questionHint ?? next.questionHint) : (next.questionHint ?? prev.questionHint),
    applied: null, canApply: null, connectsCost: null, connectsBalance: null, boost: null,
  };
}

export function snapshotHoldReason(snap: PublicJobSnapshot, s: Settings): string | null {
  if (!snap.title) return 'Held: the saved snapshot has no job title.';
  if (!snap.description) return 'Held: the saved snapshot has no job description.';
  if (s.verifiedOnly && !snap.verification) return 'Held: client payment verification was not in the saved snapshot.';
  if (s.maxExistingProposals > 0 && snap.proposalCount === null && !snap.proposalsTier) return 'Held: the current proposal count was not in the saved snapshot.';
  if (computeBid(snap.jobType, snap.budgetText, s) === null) return 'Held: no bid can be computed from the saved snapshot. Currency is unknown and no rate was stated.';
  return null;
}

function readRow(row: Record<string, unknown> | null): SnapshotRow | null {
  if (!row) return null;
  return {
    jobId: String(row.job_id), source: String(row.source), fetchedAt: String(row.fetched_at),
    sourcePostedAt: row.source_posted_at ? String(row.source_posted_at) : null,
    sourceSeenAt: row.source_seen_at ? String(row.source_seen_at) : null,
    provenance: JSON.parse(String(row.provenance)), rawPayload: String(row.raw_payload),
    rawTruncated: Number(row.raw_truncated) === 1, rawOriginalBytes: Number(row.raw_original_bytes),
    normalized: JSON.parse(String(row.normalized)) as PublicJobSnapshot,
  };
}

export async function loadSnapshot(env: Env, jobId: string): Promise<SnapshotRow | null> {
  const row = await env.DB.prepare('SELECT * FROM job_snapshots WHERE job_id = ?').bind(jobId).first<Record<string, unknown>>();
  return readRow(row);
}

async function frozen(env: Env, jobId: string): Promise<boolean> {
  const proposal = await env.DB.prepare('SELECT 1 AS n FROM proposals WHERE job_id = ?').bind(jobId).first();
  if (proposal) return true;
  const job = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(jobId).first<{ status: string }>();
  return job?.status === 'proposed';
}

// Writes the snapshot before the caller advances an import checkpoint. A completed proposal is left untouched.
// A partial import cannot replace fields that are already present.
export async function persistSnapshot(env: Env, input: PersistInput, now = new Date()): Promise<void> {
  if (!/^\d{15,22}$/.test(input.jobId)) return;
  const lease = await acquireLease(env, `snapshot:${input.jobId}`, 20_000);
  if (!lease) throw new Error('Snapshot write is busy; retry this import.');
  try {
    const existing = await loadSnapshot(env, input.jobId);
    if (existing && await frozen(env, input.jobId)) return;
    const incoming = normalizePublicJob(input.jobId, input.raw);
    const normalized = mergeSnapshots(existing?.normalized ?? null, incoming, input.partial);
    const raw = boundRawPayload(input.raw);
    const keepRaw = !!existing && (input.partial || (raw.truncated && !existing.rawTruncated));
    const fetchedAt = existing?.fetchedAt ?? now.toISOString();
    const provenance = {
      first: existing ? (object(existing.provenance)?.first ?? existing.provenance) : { ...input.provenance, fetchedAt },
      latest: { ...input.provenance, fetchedAt: now.toISOString(), partial: input.partial },
    };
    const sourcePostedAt = input.partial ? (existing?.sourcePostedAt ?? incoming.postedAt) : (incoming.postedAt ?? existing?.sourcePostedAt ?? null);
    const seen = iso(object(input.raw)?.created_at ?? object(input.raw)?.createdAt);
    const sourceSeenAt = seen ?? existing?.sourceSeenAt ?? null;
    await env.DB.prepare(`INSERT INTO job_snapshots
      (job_id, source, fetched_at, source_posted_at, source_seen_at, provenance, raw_payload, raw_truncated, raw_original_bytes, normalized, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        source_posted_at = excluded.source_posted_at, source_seen_at = excluded.source_seen_at,
        provenance = excluded.provenance, raw_payload = excluded.raw_payload, raw_truncated = excluded.raw_truncated,
        raw_original_bytes = excluded.raw_original_bytes, normalized = excluded.normalized, updated_at = excluded.updated_at`)
      .bind(input.jobId, existing?.source ?? input.source, fetchedAt, sourcePostedAt, sourceSeenAt, JSON.stringify(provenance),
        keepRaw ? existing.rawPayload : raw.json, keepRaw ? (existing.rawTruncated ? 1 : 0) : (raw.truncated ? 1 : 0),
        keepRaw ? existing.rawOriginalBytes : raw.originalBytes, JSON.stringify(normalized), now.toISOString()).run();
    // A corrected snapshot does not put a held job back in the writer. Pasting the link is the explicit retry.
  } finally { await releaseLease(env, `snapshot:${input.jobId}`, lease); }
}

