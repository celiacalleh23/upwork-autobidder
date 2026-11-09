import { acquireLease, releaseLease } from '../kv';
import { loadSettings, type Env, type Settings } from '../settings';
import { normalizeCountry, parseBudget, stripUntrusted } from './filters';
import { BIDDER_HOURLY_USD, computeBid } from './letter';

export { BIDDER_HOURLY_USD };

const snapshotUrl = (id: string) => `https://www.upwork.com/jobs/~02${id}`;

// Public snapshot captured when a job is ingested. Nothing in the normalized object is an account fact:
// applied, can_apply, Connects balance, Connects cost, and boost stay null even if a feed includes them.

export const RAW_PAYLOAD_LIMIT = 100_000;
// A later full import may return a held job to the writer. Auto then treats it like any other future draft.
export const RECOVERED_SNAPSHOT = 'Recovered public snapshot';
export const DESCRIPTION_STORE_LIMIT = 50_000;

export interface PublicJobSnapshot {
  v: 1;
  id: string;
  sourceId: string | null;
  title: string | null;
  url: string | null;
  description: string | null;
  descriptionTruncated: boolean;
  descriptionKind: 'body' | 'fragment' | null;
  jobType: 'fixed' | 'hourly' | null;
  budgetText: string | null;
  amountSource: 'price' | 'hourly-band' | null;
  explicitCurrency: string | null; // currency the feed itself named. Never invented.
  listedCurrency: 'USD' | null; // Upwork's published listing currency, only for the Hyperbach public fields.
  budgetFault: 'malformed' | 'currency-conflict' | null;
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
  contract?: BudgetContract | null;
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

export type BudgetContract = 'hyperbach-public-upwork';

// A single positive amount. Operators, ranges, zero, and blank values are not an amount.
function plainAmount(v: unknown): { text: string | null; empty: boolean; malformed: boolean } {
  if (v == null || v === '') return { text: null, empty: true, malformed: false };
  if (typeof v !== 'number' && typeof v !== 'string') return { text: null, empty: false, malformed: true };
  const s = typeof v === 'number' ? String(v) : v.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return { text: null, empty: false, malformed: true };
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return { text: null, empty: false, malformed: true };
  return { text: n.toFixed(2), empty: false, malformed: false };
}

function explicitCode(raw: Record<string, unknown>): { code: string | null; malformed: boolean } {
  const v = raw.currency;
  if (v == null || v === '') return { code: null, malformed: false };
  if (typeof v !== 'string' || !/^[A-Za-z]{3}$/.test(v.trim())) return { code: null, malformed: true };
  return { code: v.trim().toUpperCase(), malformed: false };
}

// Hyperbach's published fields for a public Upwork posting. Upwork lists those costs in USD.
// An explicit currency on the row is never replaced. Any other feed is not this contract.
function hyperbachListing(raw: Record<string, unknown>): {
  jobType: 'fixed' | 'hourly'; budgetText: string | null; amountSource: 'price' | 'hourly-band' | null;
  explicitCurrency: string | null; listedCurrency: 'USD' | null; budgetFault: 'malformed' | 'currency-conflict' | null;
} | null {
  const kind = String(raw.price_type ?? '').trim().toLowerCase();
  if (kind !== 'fixed-price' && kind !== 'hourly') return null;
  const jobType: 'fixed' | 'hourly' = kind === 'hourly' ? 'hourly' : 'fixed';
  const explicit = explicitCode(raw);
  const deny = (budgetFault: 'malformed' | 'currency-conflict', budgetText: string | null, amountSource: 'price' | 'hourly-band' | null) => ({
    jobType, budgetText, amountSource, explicitCurrency: explicit.code, listedCurrency: null as 'USD' | null, budgetFault,
  });
  if (explicit.malformed) return deny('malformed', null, null);
  const mark = (budgetText: string, amountSource: 'price' | 'hourly-band') => explicit.code && explicit.code !== 'USD'
    ? deny('currency-conflict', budgetText, amountSource)
    : { jobType, budgetText, amountSource, explicitCurrency: explicit.code, listedCurrency: explicit.code === 'USD' ? null : 'USD' as const, budgetFault: null };
  if (jobType === 'fixed') {
    const price = plainAmount(raw.price);
    const min = plainAmount(raw.price_min);
    const max = plainAmount(raw.price_max);
    if (!min.empty || !max.empty || price.malformed) return deny('malformed', null, null);
    if (price.empty || !price.text) return { jobType, budgetText: null, amountSource: null, explicitCurrency: explicit.code, listedCurrency: null, budgetFault: null };
    return mark(price.text, 'price');
  }
  const price = plainAmount(raw.price);
  const min = plainAmount(raw.price_min);
  const max = plainAmount(raw.price_max);
  if (price.malformed || min.malformed || max.malformed || !price.empty) return deny('malformed', null, null);
  if (min.empty && max.empty) return { jobType, budgetText: null, amountSource: null, explicitCurrency: explicit.code, listedCurrency: null, budgetFault: null };
  const budgetText = min.text && max.text ? `${min.text}–${max.text}/hr` : max.text ? `up to ${max.text}/hr` : `${min.text}+/hr`;
  return mark(budgetText, 'hourly-band');
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
    return null;
  }
  return jobType === 'fixed' ? moneyText(raw.fixed_budget ?? raw.fixed_price ?? raw.amount ?? raw.fixedPrice) : null;
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
  const client = object(raw.client);
  const direct = text(raw.verification_status ?? raw.payment_verification ?? client?.verification_status, 40);
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

function clipDescription(source: string | null): { text: string | null; truncated: boolean } {
  if (!source) return { text: null, truncated: false };
  return { text: source.slice(0, DESCRIPTION_STORE_LIMIT), truncated: source.length > DESCRIPTION_STORE_LIMIT };
}

// A labeled snippet stays a fragment. A description field is the post body from that source, not proof it is the whole post.
function readDescription(src: Record<string, unknown>): { text: string | null; truncated: boolean; kind: 'body' | 'fragment' | null } {
  const labeled = src.description_kind === 'fragment' || src.description_kind === 'body' ? src.description_kind : null;
  const body = passage(src.description ?? src.description_text ?? src.job_description, DESCRIPTION_STORE_LIMIT + 1);
  const fragment = passage(src.description_snippet ?? src.snippet, DESCRIPTION_STORE_LIMIT + 1);
  if (labeled === 'fragment') {
    const chosen = clipDescription(body ?? fragment);
    return { ...chosen, kind: chosen.text ? 'fragment' : null };
  }
  if (body) return { ...clipDescription(body), kind: 'body' };
  if (fragment) return { ...clipDescription(fragment), kind: 'fragment' };
  return { text: null, truncated: false, kind: null };
}

// Feed questions that are missing or an empty list stay unknown. AI-written fields are hints, not questions.
export function normalizePublicJob(jobId: string, raw: unknown, contract?: BudgetContract | null): PublicJobSnapshot {
  const src = object(raw) ?? {};
  const description = readDescription(src);
  const directBudget = text(src.budget ?? src.budget_text ?? src.budgetText, 120);
  const shaped = directBudget ? null : hyperbachListing(src);
  const listing = shaped && contract === 'hyperbach-public-upwork' ? shaped : null;
  const unscoped = shaped && !listing ? shaped : null;
  const jobType = (listing ?? unscoped)?.jobType ?? jobTypeOf(src);
  const budget = (listing ?? unscoped)?.budgetText ?? budgetText(src, jobType);
  const skillsRaw = src.skills;
  const skills = Array.isArray(skillsRaw) ? skillsRaw.map((s) => text(typeof s === 'string' ? s : object(s)?.name, 80)).filter((s): s is string => !!s).slice(0, 40) : null;
  const hint = [text(src.ai_specific_requirements_before_applying, 500), text(src.ai_anti_bot_phrase, 200)].filter(Boolean).join(' · ') || null;
  const sourceId = text(src.id ?? src.job_id ?? src.jobId, 80);
  return {
    v: 1, id: jobId, sourceId, title: text(src.title ?? src.jobTitle, 300),
    url: text(typeof src.url === 'object' ? object(src.url)?.href ?? object(src.url)?.url : src.url ?? src.link ?? src.jobUrl, 400) ?? snapshotUrl(jobId),
    description: description.text, descriptionTruncated: description.truncated, descriptionKind: description.kind, jobType, budgetText: budget,
    amountSource: (listing ?? unscoped)?.amountSource ?? null,
    explicitCurrency: (listing ?? unscoped)?.explicitCurrency ?? null,
    listedCurrency: listing?.listedCurrency ?? null,
    budgetFault: (listing ?? unscoped)?.budgetFault ?? null,
    currency: null,
    country: countryOf(src), verification: verificationOf(src),
    proposalCount: asNumber(src.proposal_count ?? src.proposalCount ?? src.applicants ?? src.client_total_applicants),
    proposalsTier: text(src.proposals_tier ?? src.proposalsTier, 40),
    postedAt: iso(src.date_posted ?? src.published_date ?? src.publishedDate ?? src.postedAt ?? src.posted_at),
    skills: skills?.length ? skills : null,
    questions: questionList(src.screening_questions ?? src.questions),
    questionHint: hint,
    applied: null, canApply: null, connectsCost: null, connectsBalance: null, boost: null,
  };
}

function storedKind(snap: PublicJobSnapshot): 'body' | 'fragment' | null {
  if (!snap.description) return null;
  return snap.descriptionKind === 'fragment' ? 'fragment' : 'body';
}

// A fragment or a cut text must not replace a fuller post. A complete body may replace a longer one: length is not proof.
function pickDescription(prev: PublicJobSnapshot, next: PublicJobSnapshot, partial: boolean): { text: string | null; truncated: boolean; kind: 'body' | 'fragment' | null } {
  const keep = (snap: PublicJobSnapshot) => ({ text: snap.description, truncated: snap.descriptionTruncated, kind: storedKind(snap) });
  if (!next.description) return keep(prev);
  if (!prev.description) return keep(next);
  if (partial) return keep(prev);
  const prevKind = storedKind(prev);
  const nextKind = storedKind(next);
  if (nextKind === 'fragment' && prevKind === 'body') return keep(prev);
  if (nextKind === 'fragment' && prevKind === 'fragment' && next.description.length < prev.description.length) return keep(prev);
  if (next.descriptionTruncated && !prev.descriptionTruncated && prevKind === 'body') return keep(prev);
  if (nextKind === 'body' && !next.descriptionTruncated) return { text: next.description, truncated: false, kind: 'body' };
  if (next.description.length < prev.description.length && next.descriptionTruncated) return keep(prev);
  return { text: next.description, truncated: next.descriptionTruncated, kind: nextKind };
}

export function mergeSnapshots(prev: PublicJobSnapshot | null, next: PublicJobSnapshot, partial: boolean): PublicJobSnapshot {
  if (!prev) return next;
  const description = pickDescription(prev, next, partial);
  return {
    ...next,
    id: prev.id,
    sourceId: prev.sourceId ?? next.sourceId,
    title: partial ? (prev.title ?? next.title) : (next.title ?? prev.title),
    url: partial ? (prev.url ?? next.url) : (next.url ?? prev.url),
    description: description.text,
    descriptionTruncated: description.truncated,
    descriptionKind: description.kind,
    jobType: partial ? (prev.jobType ?? next.jobType) : (next.jobType ?? prev.jobType),
    budgetText: partial ? (prev.budgetText ?? next.budgetText) : (next.budgetText ?? prev.budgetText),
    amountSource: partial ? (prev.amountSource ?? next.amountSource) : next.amountSource,
    explicitCurrency: partial ? (prev.explicitCurrency ?? next.explicitCurrency) : next.explicitCurrency,
    listedCurrency: partial ? (prev.listedCurrency ?? next.listedCurrency) : next.listedCurrency,
    budgetFault: partial ? (prev.budgetFault ?? next.budgetFault) : next.budgetFault,
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

// Listed USD is applied only by hyperbachListing. This refuses a conflict, a bad amount, and any other feed.
export function unverifiedPriceHold(snap: PublicJobSnapshot, _s: Settings): string | null {
  if (snap.budgetFault === 'currency-conflict' || (snap.explicitCurrency && snap.explicitCurrency !== 'USD')) return 'Held: the feed named a different currency. It was not replaced with USD. Nothing is drafted or sent.';
  if (snap.budgetFault === 'malformed') return 'Held: the feed price was zero or not a single positive amount. Nothing is drafted or sent.';
  return null;
}

export function snapshotHoldReason(snap: PublicJobSnapshot, s: Settings): string | null {
  if (!snap.title) return 'Held: the saved snapshot has no job title.';
  return unverifiedPriceHold(snap, s);
}

export type SubmissionGap =
  | 'description-missing'
  | 'description-fragment'
  | 'job-type-missing'
  | 'client-hourly-band-missing'
  | 'client-fixed-amount-missing'
  | 'currency-undocumented'
  | 'explicit-currency-not-usd'
  | 'applicant-count-missing'
  | 'verification-missing';

const GAP_LABEL: Record<SubmissionGap, string> = {
  'description-missing': 'job description',
  'description-fragment': 'full job post (the stored text is only a snippet)',
  'job-type-missing': 'job type',
  'client-hourly-band-missing': 'client hourly rate',
  'client-fixed-amount-missing': 'client fixed price',
  'currency-undocumented': 'documented currency for the stated price',
  'explicit-currency-not-usd': 'a USD client price (the feed named another currency)',
  'applicant-count-missing': 'applicant count',
  'verification-missing': 'client payment verification',
};

export function submissionGaps(snap: PublicJobSnapshot, s: Settings): SubmissionGap[] {
  const gaps: SubmissionGap[] = [];
  if (!snap.description) gaps.push('description-missing');
  else if (snap.descriptionKind === 'fragment') gaps.push('description-fragment');
  if (!snap.jobType) gaps.push('job-type-missing');
  const parsed = parseBudget(snap.jobType ?? undefined, snap.budgetText ?? undefined);
  if (snap.jobType === 'hourly' && parsed?.kind !== 'hourly') gaps.push('client-hourly-band-missing');
  if (snap.jobType === 'fixed' && !(parsed?.kind === 'fixed' && parsed.amount > 0)) gaps.push('client-fixed-amount-missing');
  const documentedUsd = snap.listedCurrency === 'USD' || snap.explicitCurrency === 'USD';
  if (snap.explicitCurrency && snap.explicitCurrency !== 'USD') gaps.push('explicit-currency-not-usd');
  else if (snap.amountSource && !documentedUsd) gaps.push('currency-undocumented');
  if (snap.proposalCount === null && !snap.proposalsTier) gaps.push('applicant-count-missing');
  if (s.verifiedOnly && !snap.verification) gaps.push('verification-missing');
  return gaps;
}

// Missing description, band, count, verification, or currency does not stop a send. A fixed price with no amount still cannot be invented.
export function submissionBlock(snap: PublicJobSnapshot, _s: Settings): string | null {
  if (snap.jobType === 'fixed' && !snap.budgetText) return 'This fixed-price job has no amount. Set the amount with Edit, then approve. None was invented.';
  return null;
}

export type DraftBasis = 'client' | 'bidder-hourly-usd' | 'unavailable';

// A stated client band uses the saved bid settings. A missing hourly band uses Rafa's USD 30 rate and does not relabel it as the client's.
export function draftBid(snap: PublicJobSnapshot, s: Settings): { amount: number | null; basis: DraftBasis } {
  if (snap.budgetFault) return { amount: null, basis: 'unavailable' };
  const parsed = parseBudget(snap.jobType ?? undefined, snap.budgetText ?? undefined);
  if (snap.jobType === 'hourly' && parsed?.kind !== 'hourly') {
    if (snap.explicitCurrency && snap.explicitCurrency !== 'USD') return { amount: null, basis: 'unavailable' };
    return { amount: BIDDER_HOURLY_USD, basis: 'bidder-hourly-usd' };
  }
  if (snap.explicitCurrency && snap.explicitCurrency !== 'USD') return { amount: null, basis: 'unavailable' };
  if (snap.jobType === 'fixed' && !(parsed?.kind === 'fixed' && parsed.amount > 0)) return { amount: null, basis: 'unavailable' };
  if (!snap.jobType) return { amount: null, basis: 'unavailable' };
  const amount = computeBid(snap.jobType, snap.budgetText, s);
  return amount === null ? { amount: null, basis: 'unavailable' } : { amount, basis: 'client' };
}

export function draftReviewNote(base: string, gaps: SubmissionGap[], basis: DraftBasis): string {
  const extra: string[] = [];
  if (basis === 'bidder-hourly-usd') extra.push(`Bid USD ${BIDDER_HOURLY_USD}/hour is Rafa's rate because the client stated no hourly rate. It is not the client's budget.`);
  if (basis === 'unavailable' && gaps.includes('client-fixed-amount-missing')) extra.push('No fixed price was stated, and none was invented.');
  if (basis === 'unavailable' && gaps.includes('job-type-missing')) extra.push('No job type was stated, so no hourly rate and no fixed price were assumed.');
  if (basis === 'unavailable' && gaps.includes('explicit-currency-not-usd')) extra.push('The feed named a non-USD currency and no usable rate, so USD 30 was not applied.');
  if (basis === 'client' && gaps.includes('currency-undocumented')) extra.push('The feed did not name a currency. The stated number is the bid.');
  if (gaps.length) extra.push(`Still blank in the source: ${gaps.map((gap) => GAP_LABEL[gap]).join('; ')}. Approving still sends with the data saved here.${basis === 'bidder-hourly-usd' || gaps.includes('client-hourly-band-missing') ? ` An hourly job with no client rate uses Rafa's USD ${BIDDER_HOURLY_USD}/hour.` : ''}`);
  return [base, ...extra].filter(Boolean).join(' ');
}

// Older rows stored a blank price as malformed. A blank field is missing data; zero and other bad values stay malformed.
export function relaxBlankMalformed(snap: PublicJobSnapshot, rawPayload: string, rawTruncated = false): PublicJobSnapshot {
  if (snap.budgetFault !== 'malformed' || snap.budgetText || rawTruncated) return snap;
  let raw: unknown;
  try { raw = JSON.parse(rawPayload); } catch { return snap; }
  const src = object(raw) ?? {};
  const blank = (value: unknown) => value == null || value === '';
  if (!blank(src.price) || !blank(src.price_min) || !blank(src.price_max)) return snap;
  if (text(src.budget ?? src.budget_text ?? src.budgetText, 120)) return snap;
  return { ...snap, budgetFault: null, amountSource: null, listedCurrency: null };
}

const DRAFTABLE_HELD = new Set([
  'Held: the saved snapshot has no job description.',
  'Held: client payment verification was not in the saved snapshot.',
  'Held: the current proposal count was not in the saved snapshot.',
  'Held: no bid can be computed from the saved snapshot. No budget or rate was stated.',
  'Held: the feed price was zero, blank, or not a single positive amount. Nothing is drafted or sent.',
  'Held: the feed price was zero or not a single positive amount. Nothing is drafted or sent.',
]);

export function heldReasonCanDraft(reason: string | null): boolean {
  if (!reason) return false;
  if (DRAFTABLE_HELD.has(reason)) return true;
  return reason.startsWith('Held: ') && reason.includes('not from the documented Hyperbach public Upwork listing');
}

function readRow(row: Record<string, unknown> | null): SnapshotRow | null {
  if (!row) return null;
  return {
    jobId: String(row.job_id), source: String(row.source), fetchedAt: String(row.fetched_at),
    sourcePostedAt: row.source_posted_at ? String(row.source_posted_at) : null,
    sourceSeenAt: row.source_seen_at ? String(row.source_seen_at) : null,
    provenance: JSON.parse(String(row.provenance)), rawPayload: String(row.raw_payload),
    rawTruncated: Number(row.raw_truncated) === 1, rawOriginalBytes: Number(row.raw_original_bytes),
    normalized: relaxBlankMalformed(JSON.parse(String(row.normalized)) as PublicJobSnapshot, String(row.raw_payload), Number(row.raw_truncated) === 1),
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
    const incoming = normalizePublicJob(input.jobId, input.raw, input.contract);
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
    // A full import that now has the public fields can be drafted. A partial hit cannot revive a held job.
    if (!input.partial && normalized.descriptionKind !== 'fragment' && !snapshotHoldReason(normalized, await loadSettings(env))) {
      await env.DB.prepare(`UPDATE jobs SET status = 'matched', reason = ? WHERE id = ? AND status = 'error' AND reason LIKE 'Held:%'
        AND NOT EXISTS (SELECT 1 FROM proposals WHERE proposals.job_id = jobs.id)`).bind(RECOVERED_SNAPSHOT, input.jobId).run();
    }
  } finally { await releaseLease(env, `snapshot:${input.jobId}`, lease); }
}

