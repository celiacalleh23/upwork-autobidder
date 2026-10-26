export interface Env {
  DB: D1Database;
  DASH_PASSWORD?: string;
  TOKEN_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string; // local testing only (a stand-in API); unset in production
  RESEND_API_KEY?: string;
  REPORT_FROM?: string; // e.g. "Upwork Auto-Bidder <reports@ltv-labs.com>" on a Resend-verified domain
  CLAUDE_MODEL: string;
  UPWORK_MCP_URL: string;
}

export type Mode = 'review' | 'auto';

export interface Settings {
  keywords: string[];
  titleOnly: boolean;
  exclude: string[];
  minFixedBudget: number;
  minHourlyRate: number;
  verifiedOnly: boolean;
  allowedCountries: string[]; // client countries to bid for; empty = any
  maxExistingProposals: number; // 0 = no limit
  minScore: number;
  letter: { template: string; rules: string };
  disclosure: { enabled: boolean; line: string };
  bid: { hourly: 'profile' | 'client_max'; fixed: 'client_budget' | 'budget_plus_10'; profileRate: number }; // profileRate: USD/hr, 0 = unset
  profileSummary: string; // Siv's notes about Rafa, added to her Upwork profile and cover letter for Claude
  scoreWeights: { profile: number; wins: number }; // % of the match score; they add up to 100
  loom: { sourceUrl: string; deleteAfterDays: number };
  caps: {
    daily: number;  // 0 = no limit
    hourly: number; // 0 = no limit
    gapMinutes: number;
    activeStart: string; // HH:MM
    activeEnd: string;   // HH:MM
    timezone: string;    // IANA
    connectsFloorEnabled: boolean; // off = keep sending until a job costs more than the balance (Siv, Oct 21)
    connectsFloor: number;
    maxConnectsEnabled: boolean; // off = apply to jobs whatever they cost in Connects (Siv, Oct 21)
    maxConnectsPerJob: number;
    boost: 'never' | 'up_to_10' | 'up_to_20';
    stopAfterErrors: number;
  };
  scanEveryMinutes: number;
  maxNewJobsPerRun: number;   // jobs scored and written per cron run (M4)
  sendingEnabled: boolean;    // M6 master switch; off until Siv/Celia turn it on in the dashboard, never in code
  fixedPriceTermsAcknowledged: boolean; // Upwork Dispute Assistance terms, acknowledged by Siv; else fixed-price jobs wait
  connectsAlertBelow: number; // email when the balance drops below this; sending continues. 0 = off
  report: { email: string; hour: number }; // email: up to 3 addresses, comma-separated; hour: 0–23 in caps.timezone
}

export interface RunSummary { at: string; scanned: number; new: number; matched: number; queued?: number; errors: number; note: string | null }

export interface State {
  mode: Mode;
  paused: boolean;
  pausedReason: string | null;
  connectsBalance: number | null;
  lastScanAt: string | null;
  consecutiveErrors: number;
  upwork: {
    connected: boolean;
    account: string | null;
    orgUid: string | null;
    toolNames: Record<string, string>; // base name → name as the Upwork MCP server lists it
    lastError: string | null;
    checkedAt: string | null;
  };
  loom: { connected: boolean; lastError: string | null; checkedAt: string | null; expiresAt: string | null }; // expiresAt: the session cookie's, when Loom sends it
  lastRun: RunSummary | null;
  trackRecordSyncedAt: string | null;
  lastSendAt: string | null;
  senderNote: string | null;             // what the sender is doing or waiting for, shown on the dashboard
  switchedToReviewReason: string | null; // set when Upwork refused an automatic confirm; cleared when Auto is turned back on
  connectsAlertSentAt: string | null;    // the low-Connects alert went out; cleared once the balance is back above the threshold
  loomAlertSentFor: string | null;       // the last Loom alert emailed (expiring:<date> or disconnected:<connected at>)
}

export const DEFAULT_SETTINGS: Settings = {
  keywords: ['Klaviyo', 'email marketing', 'email flows'],
  titleOnly: true,
  exclude: ['WordPress', 'logo design'],
  minFixedBudget: 150,
  minHourlyRate: 30,
  verifiedOnly: true,
  allowedCountries: [],
  maxExistingProposals: 50,
  minScore: 70,
  letter: {
    template: '',
    rules: [
      "Open with the client's problem, not with \"I\".",
      'Mention one relevant result from the profile when it fits. Never invent numbers or clients.',
    ].join('\n'),
  },
  disclosure: { enabled: false, line: 'Drafted with AI assistance and reviewed by me.' },
  bid: { hourly: 'client_max', fixed: 'client_budget', profileRate: 0 },
  profileSummary: '',
  scoreWeights: { profile: 50, wins: 50 },
  loom: { sourceUrl: '', deleteAfterDays: 30 },
  caps: {
    daily: 0,
    hourly: 0,
    gapMinutes: 5,
    activeStart: '07:00',
    activeEnd: '21:00',
    timezone: 'America/New_York',
    connectsFloorEnabled: false,
    connectsFloor: 20,
    maxConnectsEnabled: false,
    maxConnectsPerJob: 16,
    boost: 'never',
    stopAfterErrors: 3,
  },
  scanEveryMinutes: 5,
  maxNewJobsPerRun: 3,
  sendingEnabled: false,
  fixedPriceTermsAcknowledged: false,
  connectsAlertBelow: 0,
  report: { email: '', hour: 15 }, // 3 pm (Siv: 3 pm California)
};

export const DEFAULT_STATE: State = {
  mode: 'review',
  paused: false,
  pausedReason: null,
  connectsBalance: null,
  lastScanAt: null,
  consecutiveErrors: 0,
  upwork: { connected: false, account: null, orgUid: null, toolNames: {}, lastError: null, checkedAt: null },
  loom: { connected: false, lastError: null, checkedAt: null, expiresAt: null },
  lastRun: null,
  trackRecordSyncedAt: null,
  lastSendAt: null,
  senderNote: null,
  switchedToReviewReason: null,
  connectsAlertSentAt: null,
  loomAlertSentFor: null,
};

async function getJson<T>(env: Env, key: string, fallback: T): Promise<T> {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first<{ value: string }>();
  if (!row) return structuredClone(fallback);
  try {
    return deepMerge(structuredClone(fallback), JSON.parse(row.value));
  } catch {
    return structuredClone(fallback);
  }
}

async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(key, JSON.stringify(value)).run();
}

// The report addresses as a list (Settings keeps them comma-separated).
export const reportEmails = (s: Settings) => s.report.email.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);

export const loadSettings = (env: Env) => getJson(env, 'settings', DEFAULT_SETTINGS);
export const saveSettings = (env: Env, s: Settings) => putJson(env, 'settings', s);
export const loadState = (env: Env) => getJson(env, 'state', DEFAULT_STATE);
export async function patchState(env: Env, patch: Partial<State>): Promise<State> {
  const next = { ...(await loadState(env)), ...patch };
  await putJson(env, 'state', next);
  return next;
}

// Fill missing keys from defaults so older stored settings keep working after upgrades.
function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = isObj(b) && isObj(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------- Validation: everything coming from the dashboard is checked and clamped ----------

export class InvalidInput extends Error {}

const str = (v: unknown, max: number, field: string): string => {
  if (typeof v !== 'string') throw new InvalidInput(`${field} must be text`);
  if (v.length > max) throw new InvalidInput(`${field} is too long (max ${max} characters)`);
  return v.trim();
};
const num = (v: unknown, min: number, max: number, field: string): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new InvalidInput(`${field} must be a number`);
  if (n < min || n > max) throw new InvalidInput(`${field} must be between ${min} and ${max}`);
  return Math.round(n);
};
const bool = (v: unknown): boolean => v === true;
const list = (v: unknown, field: string): string[] => {
  if (!Array.isArray(v)) throw new InvalidInput(`${field} must be a list`);
  if (v.length > 30) throw new InvalidInput(`${field}: at most 30 entries`);
  const seen = new Set<string>();
  return v.map((x) => str(x, 60, field)).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
};
const oneOf = <T extends string>(v: unknown, opts: readonly T[], field: string): T => {
  if (!opts.includes(v as T)) throw new InvalidInput(`${field} has an unknown value`);
  return v as T;
};
const hhmm = (v: unknown, field: string): string => {
  const s = str(v, 5, field);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new InvalidInput(`${field} must look like 07:00`);
  return s;
};
const tz = (v: unknown): string => {
  const s = str(v, 60, 'Time zone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
  } catch {
    throw new InvalidInput('Time zone is not recognised (use a name like America/New_York)');
  }
  return s;
};

function weights(w: { profile: unknown; wins: unknown }) {
  const out = { profile: num(w.profile, 0, 100, 'Profile weight'), wins: num(w.wins, 0, 100, 'Past-wins weight') };
  if (out.profile + out.wins !== 100) throw new InvalidInput('The two score weights must add up to 100%');
  return out;
}

export function validateSettings(input: unknown): Settings {
  if (!isObj(input)) throw new InvalidInput('Settings must be an object');
  const i = deepMerge(structuredClone(DEFAULT_SETTINGS), input);
  const keywords = list(i.keywords, 'Keywords');
  if (keywords.length === 0) throw new InvalidInput('Add at least one keyword');
  const caps = i.caps;
  const loomUrl = str(i.loom.sourceUrl, 300, 'Loom video link');
  if (loomUrl && !/^https:\/\/(www\.)?loom\.com\/share\/[A-Za-z0-9]+/.test(loomUrl)) {
    throw new InvalidInput('Loom video link must look like https://www.loom.com/share/…');
  }
  const emails = str(i.report.email, 400, 'Report emails').split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
  if (emails.length > 3) throw new InvalidInput('Use at most 3 report emails');
  const badEmail = emails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (badEmail) throw new InvalidInput(`Report email "${badEmail}" is not a valid address`);
  const email = emails.join(', ');
  return {
    keywords,
    titleOnly: bool(i.titleOnly),
    exclude: list(i.exclude, 'Exclusions'),
    minFixedBudget: num(i.minFixedBudget, 0, 100000, 'Minimum fixed budget'),
    minHourlyRate: num(i.minHourlyRate, 0, 1000, 'Minimum hourly rate'),
    verifiedOnly: bool(i.verifiedOnly),
    allowedCountries: list(i.allowedCountries, 'Client countries'),
    maxExistingProposals: num(i.maxExistingProposals, 0, 100, 'Maximum existing proposals'),
    minScore: num(i.minScore, 0, 100, 'Minimum match score'),
    letter: { template: str(i.letter.template, 8000, 'Letter template'), rules: str(i.letter.rules, 4000, 'Letter rules') },
    disclosure: { enabled: bool(i.disclosure.enabled), line: str(i.disclosure.line, 200, 'Disclosure line') || DEFAULT_SETTINGS.disclosure.line },
    bid: {
      hourly: oneOf(i.bid.hourly, ['profile', 'client_max'] as const, 'Hourly bid'),
      fixed: oneOf(i.bid.fixed, ['client_budget', 'budget_plus_10'] as const, 'Fixed-price bid'),
      profileRate: num(i.bid.profileRate, 0, 1000, "Rafa's hourly rate"),
    },
    profileSummary: str(i.profileSummary, 3000, 'Notes about Rafa'),
    scoreWeights: weights(i.scoreWeights),
    loom: { sourceUrl: loomUrl, deleteAfterDays: num(i.loom.deleteAfterDays, 7, 365, 'Delete Loom copies after') },
    caps: {
      daily: num(caps.daily, 0, 500, 'Daily cap'),
      hourly: num(caps.hourly, 0, 60, 'Hourly cap'),
      gapMinutes: num(caps.gapMinutes, 5, 120, 'Minimum gap'),
      activeStart: hhmm(caps.activeStart, 'Active from'),
      activeEnd: hhmm(caps.activeEnd, 'Active until'),
      timezone: tz(caps.timezone),
      connectsFloorEnabled: bool(caps.connectsFloorEnabled),
      connectsFloor: num(caps.connectsFloor, 0, 1000, 'Connects floor'),
      maxConnectsEnabled: bool(caps.maxConnectsEnabled),
      maxConnectsPerJob: num(caps.maxConnectsPerJob, 1, 50, 'Max Connects per job'),
      boost: oneOf(caps.boost, ['never', 'up_to_10', 'up_to_20'] as const, 'Boost'),
      stopAfterErrors: num(caps.stopAfterErrors, 1, 10, 'Stop after errors'),
    },
    scanEveryMinutes: num(i.scanEveryMinutes, 5, 30, 'Scan interval'),
    maxNewJobsPerRun: num(i.maxNewJobsPerRun, 1, 5, 'Jobs per run'),
    sendingEnabled: bool(i.sendingEnabled),
    fixedPriceTermsAcknowledged: bool(i.fixedPriceTermsAcknowledged),
    connectsAlertBelow: num(i.connectsAlertBelow, 0, 10000, 'Connects alert'),
    report: { email, hour: num(i.report.hour, 0, 23, 'Report time') },
  };
}
