import type { Settings } from '../settings';

// Pure job filtering: no network, no storage. Job text is untrusted data; it is only matched against, never acted on.

export interface UpworkJob {
  id: string;
  title: string;
  url?: string;
  job_type?: string; // hourly | fixed
  budget?: string;   // "10.00–30.00/hr", "30.00+/hr", "up to 30.00/hr", "5.00"
  client?: { country?: string; verification_status?: string };
  proposals_tier?: string; // "Fewer than 5", "5 to 10", …, "50+"
  proposal_count?: number;
  applied?: boolean;
  description_snippet?: string;
  description?: string;
  published_date?: string;
  created_date?: string;
  skills?: unknown; // Upwork skill names (keyword trends)
}

export type Verdict = { status: 'matched'; keywords: string[] } | { status: 'filtered'; reason: string; keywords: string[] };

export const stripUntrusted = (s: string | undefined) => (s ?? '').replace(/<\/?untrusted_participant_content>/g, '').trim();

const num = (s: string) => Number(s.replace(/[$,\s]/g, ''));

export type Budget = { kind: 'fixed'; amount: number } | { kind: 'hourly'; min: number | null; max: number | null };

export function parseBudget(jobType: string | undefined, raw: string | undefined): Budget | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const hourly = jobType === 'hourly' || /\/hr\b/i.test(s);
  const nums = [...s.matchAll(/\$?\d[\d,]*(?:\.\d+)?/g)].map((m) => num(m[0])).filter(Number.isFinite);
  if (!nums.length) return null;
  if (!hourly) return { kind: 'fixed', amount: nums[0] };
  if (/up\s*to/i.test(s)) return { kind: 'hourly', min: null, max: nums[0] };
  if (/\+/.test(s) && nums.length === 1) return { kind: 'hourly', min: nums[0], max: null };
  return { kind: 'hourly', min: nums[0], max: nums[1] ?? nums[0] };
}

// Lowest number of proposals a tier implies; null when unknown.
export function tierLowerBound(tier: string | undefined): number | null {
  const s = (tier ?? '').toLowerCase().trim();
  if (!s) return null;
  if (/^fewer than/.test(s) || /^less than/.test(s)) return 0;
  const m = /^(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}

const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'united states', us: 'united states', 'u.s.': 'united states', 'u.s.a.': 'united states', 'united states of america': 'united states', america: 'united states',
  uk: 'united kingdom', 'u.k.': 'united kingdom', 'great britain': 'united kingdom', britain: 'united kingdom', england: 'united kingdom', scotland: 'united kingdom', wales: 'united kingdom', 'northern ireland': 'united kingdom',
  // Upwork sometimes sends ISO 3166 alpha-3 codes instead of names (seen Oct 22: USA, BEL, NLD, IMN).
  gbr: 'united kingdom', can: 'canada', aus: 'australia', nzl: 'new zealand', irl: 'ireland', deu: 'germany', fra: 'france',
  nld: 'netherlands', bel: 'belgium', che: 'switzerland', aut: 'austria', esp: 'spain', prt: 'portugal', ita: 'italy',
  swe: 'sweden', nor: 'norway', dnk: 'denmark', fin: 'finland', pol: 'poland', isr: 'israel', are: 'united arab emirates',
  sau: 'saudi arabia', ind: 'india', pak: 'pakistan', bgd: 'bangladesh', phl: 'philippines', sgp: 'singapore', hkg: 'hong kong',
  jpn: 'japan', kor: 'south korea', chn: 'china', mex: 'mexico', bra: 'brazil', arg: 'argentina', col: 'colombia', chl: 'chile',
  per: 'peru', ecu: 'ecuador', zaf: 'south africa', nga: 'nigeria', egy: 'egypt', tur: 'turkey', rus: 'russia', ukr: 'ukraine',
  imn: 'isle of man', jey: 'jersey', ggy: 'guernsey', lux: 'luxembourg', mlt: 'malta', cyp: 'cyprus', grc: 'greece', cze: 'czechia',
};
export function normalizeCountry(s: string | undefined): string {
  const k = (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return COUNTRY_ALIASES[k] ?? k;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-word, case-insensitive; a keyword with several words matches them in order with any spacing.
export function containsTerm(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  const pattern = t.split(/\s+/).map(escapeRe).join('\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

// Re-check of a stored, still-waiting job after the settings changed. Only uses what the jobs table keeps
// (title, country, budget); M4 re-runs evaluateJob on fresh Upwork data before scoring anyway.
export interface StoredJob { title: string; job_type: string | null; budget: string | null; client_country: string | null }
export function recheckStored(job: StoredJob, s: Settings): string | null {
  const title = stripUntrusted(job.title);
  const excluded = s.exclude.find((x) => containsTerm(title, x));
  if (excluded) return `Excluded word: ${excluded}`;
  if (s.allowedCountries.length) {
    const country = normalizeCountry(job.client_country ?? undefined);
    if (!country) return 'Client country unknown';
    if (!s.allowedCountries.some((c) => normalizeCountry(c) === country)) return `Client country: ${job.client_country}`;
  }
  const budget = parseBudget(job.job_type ?? undefined, job.budget ?? undefined);
  if (budget?.kind === 'fixed' && s.minFixedBudget > 0 && budget.amount < s.minFixedBudget) return `Budget $${budget.amount} below $${s.minFixedBudget}`;
  if (budget?.kind === 'hourly' && s.minHourlyRate > 0 && budget.max !== null && budget.max < s.minHourlyRate) {
    return `Rate up to $${budget.max}/hr below $${s.minHourlyRate}/hr`;
  }
  return null;
}

// Per-job Connects limit, only when switched on in Settings. Returns the reason to skip, or null.
export function connectsOverLimit(cost: number | null, s: Settings): string | null {
  if (!s.caps.maxConnectsEnabled || cost === null) return null;
  return cost > s.caps.maxConnectsPerJob ? `Costs ${cost} Connects (max ${s.caps.maxConnectsPerJob})` : null;
}

// Filter reasons that recheckStored can re-evaluate from stored data, so a job dropped by a setting that changed since
// (a misspelt country, a removed exclusion, a lowered budget) can come back.
// 'Upwork says this job can no longer be applied to' was also given (until Oct 22) when only Connects were short.
const REOPENABLE = ['Client country:', 'Excluded word:', 'Budget $', 'Rate up to $', 'Upwork says this job can no longer be applied to'];

// Upwork's can_apply is false both for a closed job and when the balance can't pay the job's Connects. Only the first
// is a reason to drop the job; the second waits for Connects (the sender checks the balance before sending).
export function cannotApply(canApply: boolean | null, cost: number | null, balance: number | null): 'connects' | 'closed' | null {
  if (canApply !== false) return null;
  return cost !== null && balance !== null && balance < cost ? 'connects' : 'closed';
}
export const CLOSED_REASON = 'Job closed on Upwork (no longer takes proposals)';
export const reopenable = (reason: string | null) => !!reason && REOPENABLE.some((p) => reason.startsWith(p));

export function evaluateJob(job: UpworkJob, s: Settings, invitedJobIds: Set<string>): Verdict {
  const title = stripUntrusted(job.title);
  const body = stripUntrusted(job.description || job.description_snippet);
  const keywords = s.keywords.filter((k) => containsTerm(title, k) || (!s.titleOnly && containsTerm(body, k)));
  const no = (reason: string): Verdict => ({ status: 'filtered', reason, keywords });

  if (job.applied === true) return no('Already applied');
  if (invitedJobIds.has(String(job.id))) return no('Invited: answer the invitation on Upwork');
  if (!keywords.length) return no(s.titleOnly ? 'No keyword in the title' : 'No keyword in the title or description');

  const excluded = s.exclude.find((x) => containsTerm(title, x) || containsTerm(body, x));
  if (excluded) return no(`Excluded word: ${excluded}`);

  if (s.allowedCountries.length) {
    const country = normalizeCountry(job.client?.country);
    if (!country) return no('Client country unknown');
    if (!s.allowedCountries.some((c) => normalizeCountry(c) === country)) return no(`Client country: ${job.client?.country}`);
  }

  if (s.verifiedOnly && job.client?.verification_status !== 'VERIFIED') return no('Client payment not verified');

  const budget = parseBudget(job.job_type, job.budget);
  if (budget?.kind === 'fixed' && s.minFixedBudget > 0 && budget.amount < s.minFixedBudget) {
    return no(`Budget $${budget.amount} below $${s.minFixedBudget}`);
  }
  // Hourly: drop only when the posted maximum is known and below the minimum (Upwork's overlap rule; no-range jobs stay).
  if (budget?.kind === 'hourly' && s.minHourlyRate > 0 && budget.max !== null && budget.max < s.minHourlyRate) {
    return no(`Rate up to $${budget.max}/hr below $${s.minHourlyRate}/hr`);
  }

  if (s.maxExistingProposals > 0) {
    const count = typeof job.proposal_count === 'number' ? job.proposal_count : tierLowerBound(job.proposals_tier);
    if (count !== null && count > s.maxExistingProposals) return no(`Already ${job.proposals_tier ?? count} proposals`);
  }

  return { status: 'matched', keywords };
}
