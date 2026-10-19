export interface Env {
  DB: D1Database;
  DASH_USER?: string;
  DASH_PASSWORD?: string;
  TOKEN_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  RESEND_API_KEY?: string;
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
  maxExistingProposals: number; // 0 = no limit
  minScore: number;
  letter: { template: string; rules: string };
  disclosure: { enabled: boolean; line: string };
  bid: { hourly: 'profile' | 'client_max'; fixed: 'client_budget' | 'budget_plus_10' };
  loom: { sourceUrl: string; deleteAfterDays: number };
  caps: {
    daily: number;
    hourly: number;
    gapMinutes: number;
    activeStart: string; // HH:MM
    activeEnd: string;   // HH:MM
    timezone: string;    // IANA
    connectsFloor: number;
    maxConnectsPerJob: number;
    boost: 'never' | 'up_to_10' | 'up_to_20';
    stopAfterErrors: number;
  };
  scanEveryMinutes: number;
  report: { email: string };
}

export interface State {
  mode: Mode;
  paused: boolean;
  pausedReason: string | null;
  connectsBalance: number | null;
  lastScanAt: string | null;
  consecutiveErrors: number;
  upwork: { connected: boolean; account: string | null };
  loom: { connected: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  keywords: ['Klaviyo', 'email marketing', 'email flows'],
  titleOnly: true,
  exclude: ['WordPress', 'logo design'],
  minFixedBudget: 150,
  minHourlyRate: 30,
  verifiedOnly: true,
  maxExistingProposals: 50,
  minScore: 70,
  letter: {
    template: '',
    rules: [
      "Open with the client's problem, not with \"I\".",
      'Name one relevant past result. Never invent numbers or clients.',
      'Answer every screening question directly.',
      'No email, phone, social handles or outside links except the Loom video.',
      'End with the Loom line: "I recorded a short video for this: {loom_link}"',
    ].join('\n'),
  },
  disclosure: { enabled: false, line: 'Drafted with AI assistance and reviewed by me.' },
  bid: { hourly: 'profile', fixed: 'client_budget' },
  loom: { sourceUrl: '', deleteAfterDays: 30 },
  caps: {
    daily: 15,
    hourly: 3,
    gapMinutes: 10,
    activeStart: '07:00',
    activeEnd: '21:00',
    timezone: 'America/New_York',
    connectsFloor: 20,
    maxConnectsPerJob: 16,
    boost: 'never',
    stopAfterErrors: 3,
  },
  scanEveryMinutes: 5,
  report: { email: '' },
};

export const DEFAULT_STATE: State = {
  mode: 'review',
  paused: false,
  pausedReason: null,
  connectsBalance: null,
  lastScanAt: null,
  consecutiveErrors: 0,
  upwork: { connected: false, account: null },
  loom: { connected: false },
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
  const email = str(i.report.email, 200, 'Report email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InvalidInput('Report email is not a valid address');
  return {
    keywords,
    titleOnly: bool(i.titleOnly),
    exclude: list(i.exclude, 'Exclusions'),
    minFixedBudget: num(i.minFixedBudget, 0, 100000, 'Minimum fixed budget'),
    minHourlyRate: num(i.minHourlyRate, 0, 1000, 'Minimum hourly rate'),
    verifiedOnly: bool(i.verifiedOnly),
    maxExistingProposals: num(i.maxExistingProposals, 0, 100, 'Maximum existing proposals'),
    minScore: num(i.minScore, 0, 100, 'Minimum match score'),
    letter: { template: str(i.letter.template, 8000, 'Letter template'), rules: str(i.letter.rules, 4000, 'Letter rules') },
    disclosure: { enabled: bool(i.disclosure.enabled), line: str(i.disclosure.line, 200, 'Disclosure line') || DEFAULT_SETTINGS.disclosure.line },
    bid: {
      hourly: oneOf(i.bid.hourly, ['profile', 'client_max'] as const, 'Hourly bid'),
      fixed: oneOf(i.bid.fixed, ['client_budget', 'budget_plus_10'] as const, 'Fixed-price bid'),
    },
    loom: { sourceUrl: loomUrl, deleteAfterDays: num(i.loom.deleteAfterDays, 7, 365, 'Delete Loom copies after') },
    caps: {
      daily: num(caps.daily, 1, 40, 'Daily cap'),
      hourly: num(caps.hourly, 1, 6, 'Hourly cap'),
      gapMinutes: num(caps.gapMinutes, 5, 120, 'Minimum gap'),
      activeStart: hhmm(caps.activeStart, 'Active from'),
      activeEnd: hhmm(caps.activeEnd, 'Active until'),
      timezone: tz(caps.timezone),
      connectsFloor: num(caps.connectsFloor, 0, 1000, 'Connects floor'),
      maxConnectsPerJob: num(caps.maxConnectsPerJob, 1, 50, 'Max Connects per job'),
      boost: oneOf(caps.boost, ['never', 'up_to_10', 'up_to_20'] as const, 'Boost'),
      stopAfterErrors: num(caps.stopAfterErrors, 1, 10, 'Stop after errors'),
    },
    scanEveryMinutes: num(i.scanEveryMinutes, 5, 30, 'Scan interval'),
    report: { email },
  };
}
