import { containsTerm, parseBudget, stripUntrusted, tierLowerBound } from './filters';

// "Why this job": what speaks for and against a scored job, shown on review cards and in Jobs found.
// Facts come from the job and the scores (no AI); Claude adds up to three short points about the work itself.

export interface JobFacts {
  title: string;
  keywords: string[];
  proposalsTier: string | null;
  postedAt: string | null;
  jobType: string | null;
  budget: string | null;
  connectsCost: number | null;
  winScore: number | null;
  profileScore: number;
}
export interface Analysis { pros: string[]; cons: string[] }

const MAX_EACH = 8;

export function cleanPoints(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string')
    .map((x) => stripUntrusted(x).replace(/\s+/g, ' ').trim().slice(0, 100))
    .filter(Boolean).slice(0, 3);
}

export function jobAnalysis(f: JobFacts, ai: Analysis = { pros: [], cons: [] }, now = Date.now()): Analysis {
  const pros: string[] = [];
  const cons: string[] = [];
  const title = stripUntrusted(f.title);

  const inTitle = f.keywords.filter((k) => containsTerm(title, k));
  if (inTitle.length) pros.push(`"${inTitle.join('", "')}" in the title`);
  else if (f.keywords.length) cons.push(`"${f.keywords.join('", "')}" only in the description`);

  if (f.winScore !== null) {
    if (f.winScore >= 70) pros.push(`Similar to jobs Rafa won (${f.winScore}/100)`);
    else if (f.winScore <= 30) cons.push(`Unlike Rafa's past wins (${f.winScore}/100)`);
  }
  if (f.profileScore >= 70) pros.push(`Strong fit with Rafa's profile (${f.profileScore}/100)`);
  else if (f.profileScore < 40) cons.push(`Weak fit with Rafa's profile (${f.profileScore}/100)`);

  const tier = tierLowerBound(f.proposalsTier ?? undefined);
  if (tier === 0) pros.push('Few proposals so far (fewer than 5)');
  else if (tier !== null && tier >= 20) cons.push(`Crowded: ${f.proposalsTier} proposals`);

  const posted = f.postedAt ? Date.parse(f.postedAt.includes('T') ? f.postedAt : `${f.postedAt.replace(' ', 'T')}Z`) : NaN;
  if (Number.isFinite(posted)) {
    const minutes = Math.max(0, Math.round((now - posted) / 60_000));
    if (minutes <= 60) pros.push(`Posted ${minutes} min ago`);
    else if (minutes > 24 * 60) cons.push(`Posted ${Math.round(minutes / 1440)} day(s) ago`);
  }

  const b = parseBudget(f.jobType ?? undefined, f.budget ?? undefined);
  if (b?.kind === 'fixed') {
    if (b.amount >= 500) pros.push(`Budget $${b.amount}`);
    else if (b.amount < 50) cons.push(`Small budget ($${b.amount})`);
  } else if (b?.kind === 'hourly' && b.max !== null) {
    if (b.max >= 50) pros.push(`Up to $${b.max}/hr`);
    else if (b.max < 20) cons.push(`Low rate (up to $${b.max}/hr)`);
  }

  if (f.connectsCost !== null) {
    if (f.connectsCost >= 16) cons.push(`Costs ${f.connectsCost} Connects`);
    else if (f.connectsCost <= 8) pros.push(`Only ${f.connectsCost} Connects`);
  }

  return {
    pros: [...cleanPoints(ai.pros), ...pros].slice(0, MAX_EACH),
    cons: [...cleanPoints(ai.cons), ...cons].slice(0, MAX_EACH),
  };
}

export function parseAnalysis(raw: string | null): Analysis | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as Partial<Analysis>;
    return { pros: Array.isArray(a.pros) ? a.pros.map(String) : [], cons: Array.isArray(a.cons) ? a.cons.map(String) : [] };
  } catch { return null; }
}
