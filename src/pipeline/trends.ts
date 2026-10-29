import { McpError } from '../mcp';
import { findKey, upworkClient } from '../oauth';
import { loadState, type Env } from '../settings';
import { stripUntrusted } from './filters';

// Keyword trends (Celia, Oct 29): what clients are posting, to find keywords worth bidding on. Upwork does not share
// search volumes, so the figures come from open job posts: how many are posted a day, the competition, budgets,
// countries and the skills clients tag them with. A lookup is on demand, at most 3 small pages per keyword
// (BUILD_PLAN §2: modest pace, limit ≤ 10), and the same keyword is not looked up again within 30 minutes.

export const MAX_KEYWORDS = 5;
const PAGES = 3;
const CACHE_MS = 30 * 60_000;

export type Mode = 'title' | 'anywhere';
export interface TrendJob {
  title?: string; url?: string; job_type?: string; budget?: string; proposals_tier?: string; skills?: unknown;
  client?: { country?: string; verification_status?: string }; published_date?: string; created_date?: string;
}
export interface KeywordInsight {
  keyword: string; mode: Mode; at: string;
  sample: number;           // open jobs read (the newest, up to 30)
  more: boolean;            // Upwork has more open jobs than the sample
  perDay: number | null;    // new posts a day, estimated from the sample's posting times
  competition: { known: number; under5: number; under10: number; over20: number }; // % of jobs with a known tier
  fixedMedian: number | null; hourlyMedianTop: number | null; hourlyShare: number; verifiedShare: number;
  countries: [string, number][];
  skills: [string, number][]; // skills clients tag these jobs with: related keywords to try
  examples: { title: string; url: string | null; posted: string | null; budget: string | null; tier: string | null }[];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const nums = (s: string) => [...s.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
const clean = (s: unknown, max: number) => stripUntrusted(String(s ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);
export const skillsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => clean(x, 60)).filter(Boolean).slice(0, 25) : []);

function top(counts: Map<string, number>, n: number): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

export function analyzeJobs(keyword: string, mode: Mode, jobs: TrendJob[], more: boolean, now = Date.now()): KeywordInsight {
  const times = jobs.map((j) => Date.parse(j.published_date ?? j.created_date ?? '')).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : NaN;
  // The newest N open jobs span from the oldest of them to now: N over that time is the posting pace.
  const perDay = times.length >= 2 ? Math.round((times.length / Math.max((now - oldest) / 86400_000, 1 / 24)) * 10) / 10 : null;

  const tiers = jobs.map((j) => (j.proposals_tier ?? '').toLowerCase()).filter(Boolean);
  const under5 = tiers.filter((t) => /fewer|less/.test(t)).length;
  const under10 = under5 + tiers.filter((t) => /^5 to 10/.test(t)).length;
  const over20 = tiers.filter((t) => /^20 to|50\+/.test(t)).length;

  const fixed: number[] = [], hourlyTop: number[] = [];
  let hourly = 0;
  for (const j of jobs) {
    const b = j.budget ?? '';
    if (j.job_type === 'hourly' || /\/hr/i.test(b)) { hourly++; const n = nums(b); if (n.length) hourlyTop.push(Math.max(...n)); }
    else { const n = nums(b); if (n.length) fixed.push(n[0]); }
  }

  const kw = keyword.toLowerCase();
  const skills = new Map<string, number>(), countries = new Map<string, number>();
  for (const j of jobs) {
    for (const s of new Set(skillsOf(j.skills))) if (s.toLowerCase() !== kw) skills.set(s, (skills.get(s) ?? 0) + 1);
    const c = clean(j.client?.country, 40);
    if (c) countries.set(c, (countries.get(c) ?? 0) + 1);
  }
  return {
    keyword, mode, at: new Date(now).toISOString(), sample: jobs.length, more, perDay,
    competition: { known: tiers.length, under5: pct(under5, tiers.length), under10: pct(under10, tiers.length), over20: pct(over20, tiers.length) },
    fixedMedian: median(fixed), hourlyMedianTop: median(hourlyTop), hourlyShare: pct(hourly, jobs.length),
    verifiedShare: pct(jobs.filter((j) => /verified/i.test(j.client?.verification_status ?? '') && !/unverified/i.test(j.client?.verification_status ?? '')).length, jobs.length),
    countries: top(countries, 5), skills: top(skills, 15),
    examples: jobs.slice(0, 5).map((j) => ({
      title: clean(j.title, 200), url: typeof j.url === 'string' && /^https:\/\/www\.upwork\.com\//.test(j.url) ? j.url : null,
      posted: j.published_date ?? j.created_date ?? null, budget: j.budget ? clean(j.budget, 40) : null, tier: j.proposals_tier ?? null,
    })),
  };
}

// Keywords from the dashboard: 1–5, trimmed, 2–60 characters; a title search ANDs its words, so at most 4 there.
export function parseKeywords(input: unknown, mode: Mode): string[] {
  const list = (Array.isArray(input) ? input : String(input ?? '').split(','))
    .map((k) => String(k).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const unique = list.filter((k, i) => list.findIndex((x) => x.toLowerCase() === k.toLowerCase()) === i); // first spelling wins
  if (!unique.length) throw new RangeError('Type at least one keyword');
  if (unique.length > MAX_KEYWORDS) throw new RangeError(`Up to ${MAX_KEYWORDS} keywords at a time`);
  for (const k of unique) {
    if (k.length < 2 || k.length > 60) throw new RangeError(`"${k.slice(0, 60)}": use 2 to 60 characters`);
    if (mode === 'title' && k.split(' ').length > 4) throw new RangeError(`"${k}": a title search needs every word in the title, so use at most 4 words (or search anywhere in the post)`);
  }
  return unique;
}

async function searchJobs(env: Env, keyword: string, mode: Mode): Promise<{ jobs: TrendJob[]; more: boolean }> {
  const state = await loadState(env);
  const tool = state.upwork.toolNames.find_jobs;
  if (!state.upwork.connected || !tool || !state.upwork.orgUid) throw new McpError('Connect Upwork first (Settings → Reports and connections).');
  const client = await upworkClient(env);
  const jobs: TrendJob[] = [];
  let cursor: string | undefined, more = false;
  for (let page = 0; page < PAGES; page++) {
    const r = await client.callTool(tool, { action: 'search', org_uid: state.upwork.orgUid, params: {
      ...(mode === 'title' ? { title: keyword } : { query: keyword }), sort: 'recency', limit: 10, ...(cursor ? { cursor } : {}),
    } });
    const rows = findKey(r, 'jobs');
    if (Array.isArray(rows)) jobs.push(...(rows as TrendJob[]));
    const info = findKey(r, 'pageInfo') as { hasNextPage?: boolean; endCursor?: string } | undefined;
    const next = findKey(r, 'next_cursor') ?? (info?.hasNextPage ? info.endCursor : undefined);
    more = typeof next === 'string' && !!next && (info?.hasNextPage !== false) && findKey(r, 'hasMore') !== false;
    if (!more || !Array.isArray(rows) || !rows.length) break;
    cursor = next as string;
  }
  return { jobs, more };
}

export async function exploreKeywords(env: Env, keywords: string[], mode: Mode, now = Date.now()): Promise<KeywordInsight[]> {
  const out: KeywordInsight[] = [];
  for (const keyword of keywords) {
    const cached = await env.DB.prepare('SELECT data FROM keyword_lookups WHERE keyword = ? AND mode = ? AND at >= ? ORDER BY id DESC LIMIT 1')
      .bind(keyword.toLowerCase(), mode, new Date(now - CACHE_MS).toISOString()).first<{ data: string }>();
    if (cached) { out.push(JSON.parse(cached.data) as KeywordInsight); continue; }
    const { jobs, more } = await searchJobs(env, keyword, mode);
    const insight = analyzeJobs(keyword, mode, jobs, more, now);
    await env.DB.prepare('INSERT INTO keyword_lookups (keyword, mode, at, per_day, data) VALUES (?, ?, ?, ?, ?)')
      .bind(keyword.toLowerCase(), mode, insight.at, insight.perDay, JSON.stringify(insight)).run();
    out.push(insight);
  }
  return out;
}

// Earlier lookups, newest first, so the pace of a keyword can be compared over time.
export async function lookupHistory(env: Env, limit = 60): Promise<{ keyword: string; mode: Mode; at: string; perDay: number | null; sample: number }[]> {
  const { results } = await env.DB.prepare('SELECT keyword, mode, at, per_day, data FROM keyword_lookups ORDER BY id DESC LIMIT ?').bind(limit)
    .all<{ keyword: string; mode: Mode; at: string; per_day: number | null; data: string }>();
  return results.map((r) => {
    let sample = 0;
    try { sample = (JSON.parse(r.data) as KeywordInsight).sample; } catch { /* old or broken row */ }
    return { keyword: r.keyword, mode: r.mode, at: r.at, perDay: r.per_day, sample };
  });
}

// Skills on the jobs the scanner saw (every job its searches return, matched or not), this week against the week before.
export interface SkillTrend { skill: string; thisWeek: number; lastWeek: number }
export function skillTrends(rows: { skills: string | null; seen_at: string }[], now = Date.now()): { jobs: number; trends: SkillTrend[] } {
  const week = 7 * 86400_000;
  const cur = new Map<string, number>(), prev = new Map<string, number>();
  let jobs = 0;
  for (const r of rows) {
    const t = Date.parse(`${r.seen_at.replace(' ', 'T')}${r.seen_at.endsWith('Z') ? '' : 'Z'}`);
    if (!Number.isFinite(t) || t < now - 2 * week) continue;
    let list: string[] = [];
    try { list = skillsOf(JSON.parse(r.skills ?? '[]')); } catch { continue; }
    const m = t >= now - week ? cur : prev;
    if (m === cur) jobs++;
    for (const s of new Set(list)) m.set(s, (m.get(s) ?? 0) + 1);
  }
  const trends = [...new Set([...cur.keys(), ...prev.keys()])]
    .map((skill) => ({ skill, thisWeek: cur.get(skill) ?? 0, lastWeek: prev.get(skill) ?? 0 }))
    .sort((a, b) => b.thisWeek - a.thisWeek || (b.thisWeek - b.lastWeek) - (a.thisWeek - a.lastWeek) || a.skill.localeCompare(b.skill))
    .slice(0, 25);
  return { jobs, trends };
}

export async function loadSkillTrends(env: Env, now = Date.now()) {
  const since = new Date(now - 14 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const { results } = await env.DB.prepare('SELECT skills, seen_at FROM jobs WHERE seen_at >= ? AND skills IS NOT NULL LIMIT 20000').bind(since)
    .all<{ skills: string | null; seen_at: string }>();
  return skillTrends(results, now);
}
