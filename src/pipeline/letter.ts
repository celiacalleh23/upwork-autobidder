import type { Settings } from '../settings';
import { parseBudget, stripUntrusted } from './filters';

// Pure letter and bid logic: no network. Everything Claude writes passes through these checks before it is stored.

export const MAX_LETTER = 5000;
// Rafa's own hourly rate. Used only when an hourly job has no client band. Never stored as the client budget.
export const BIDDER_HOURLY_USD = 30;
export const MAX_OPENING = 300; // one sentence (Siv, Oct 27)
export const MAX_OPENING_SENTENCES = 1;

// Sentence ends: . ! ? followed by a space or the end (not inside numbers like 4.5 or "e.g. ").
export function countSentences(text: string): number {
  return text.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/).filter((s) => s.trim()).length;
}

// Contact details are not allowed in Upwork cover letters
export function contactDetailsIn(text: string): string | null {
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) return 'an email address';
  const phoneLike = text.match(/\+?\d[\d\s().-]{8,}\d/g) ?? [];
  if (phoneLike.some((m) => m.replace(/\D/g, '').length >= 10)) return 'a phone number';
  if (/(wa\.me|whatsapp|telegram|t\.me\/|skype|calendly\.com|linkedin\.com|instagram\.com|@[A-Za-z0-9_]{3,}\b)/i.test(text)) return 'a social handle or outside contact link';
  return null;
}

const LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|io|co|net|org|app|me|ly|gg)\b/i;

// Claude's text may not add links or contact details: only the template carries links.
export function problemsInWritten(text: string): string | null {
  if (LINK_RE.test(text)) return 'a link';
  return contactDetailsIn(text);
}

const META_PHRASES = [
  'saved job post',
  'saved snapshot',
  'did not include a description',
  'no requirement that was not stated',
  'adds no requirement',
  'this sentence',
  'search snippet',
  'not the full job',
  'source did not include',
  'template placeholder',
  'internal note',
  'missing in the source',
];

// Internal notes and template tokens must never be stored in a client letter.
export function metaLanguageIn(text: string): string | null {
  if (/\{[a-z_]+\}/i.test(text)) return 'a template placeholder';
  const hit = META_PHRASES.find((phrase) => text.toLowerCase().includes(phrase));
  return hit ? 'internal wording' : null;
}

const HIRING_WORDS = /\b(needed|expert|wanted|hiring|looking for)\b/i;

// A title-only opener must be one natural sentence. It must not paste the title or its hiring words.
export function titleOnlyOpeningProblem(opening: string, title: string): string | null {
  const structural = checkOpening(opening);
  if (structural) return structural;
  if (opening.includes('|')) return 'the opening copies a title divider';
  if (HIRING_WORDS.test(opening)) return 'the opening copies hiring words from the title';
  if (/^i\b/i.test(opening.trim())) return 'the opening starts with I';
  const raw = stripUntrusted(title).replace(/\s+/g, ' ').trim();
  if (raw.length >= 12 && opening.toLowerCase().includes(raw.toLowerCase())) return 'the opening pastes the raw title';
  if (opening.trim().split(/\s+/).length > 35) return 'the opening is longer than 35 words';
  return null;
}

// Used only after the letter model fails the check above. It names the kind of work in the title and does not paste the title.
export function fallbackTitleOpening(title: string): string {
  const klaviyo = /\bklaviyo\b/i.test(title);
  const email = /\bemail\b/i.test(title);
  if (klaviyo && email) return 'The Klaviyo and email marketing work in your post is where I would start.';
  if (klaviyo) return 'The Klaviyo work in your post is where I would start.';
  if (email) return 'The email marketing work in your post is where I would start.';
  return 'The work in your post is where I would start.';
}

export function checkOpening(opening: string): string | null {
  const t = opening.trim();
  if (t.length < 25) return 'the opening is too short';
  if (t.length > MAX_OPENING) return `the opening is longer than ${MAX_OPENING} characters`;
  const meta = metaLanguageIn(t);
  if (meta) return `the opening contains ${meta}`;
  const p = problemsInWritten(t);
  if (p) return `the opening contains ${p}`;
  const n = countSentences(t);
  return n > MAX_OPENING_SENTENCES ? `the opening has ${n} sentences (max ${MAX_OPENING_SENTENCES})` : null;
}

// Template placeholders: {opening} is Claude's paragraph; {loom_link} is the job's Loom copy (M5) or, until then, the
// source video. Without {opening} the paragraph goes first. Without a video the line holding {loom_link} is dropped.
// The AI disclosure line (Upwork Terms §9.7), when Siv turns it on, goes at the very end.
export function assembleLetter(template: string, opening: string, loomUrl: string | null, disclosure: string | null = null): string {
  const base = template.trim() || '{opening}';
  // An empty opening (Settings → personal sentence off) leaves the template as is, minus the placeholder line.
  let letter = !opening.trim()
    ? base.split('\n').filter((line) => line.trim() !== '{opening}').join('\n').replace('{opening}', '')
    : base.includes('{opening}') ? base.replace('{opening}', opening.trim()) : `${opening.trim()}\n\n${base}`;
  letter = loomUrl
    ? letter.replaceAll('{loom_link}', loomUrl)
    : letter.split('\n').filter((line) => !line.includes('{loom_link}')).join('\n');
  if (disclosure?.trim()) letter = `${letter.trim()}\n\n${disclosure.trim()}`;
  return letter.replace(/\n{3,}/g, '\n\n').trim();
}

// Swap every Loom share link in a letter for the current source video (until M5 makes one copy per job).
export function swapLoomLink(letter: string, loomUrl: string): string {
  return letter.replace(/https:\/\/(?:www\.)?loom\.com\/share\/[A-Za-z0-9]+(?:\?[^\s]*)?/g, loomUrl);
}

export function checkLetter(letter: string, loomUrl: string | null): string | null {
  if (letter.length > MAX_LETTER) return `the letter is longer than ${MAX_LETTER} characters (${letter.length})`;
  const withoutLoom = loomUrl ? letter.replaceAll(loomUrl, '') : letter;
  const meta = metaLanguageIn(withoutLoom);
  if (meta) return `the letter contains ${meta}`;
  const found = contactDetailsIn(withoutLoom);
  return found ? `the letter contains ${found}` : null;
}

export const FIXED_AMOUNT_MESSAGE = 'This fixed-price job has no amount. Set the amount with Edit, then approve. None was invented.';

// The sender already reads contract terms. This only chooses the bid from that read and the saved draft.
export function resolveSendBid(input: {
  jobType: string | null;
  bid: number | null;
  bidBasis: string | null;
  liveType: 'fixed' | 'hourly' | null;
  liveBudget: string | null;
  settings: Settings;
}): { jobType: string | null; bid: number | null; basis: 'stored' | 'client' | 'bidder-hourly-usd'; hold: string | null } {
  const jobType = input.jobType === 'fixed' || input.jobType === 'hourly' ? input.jobType : input.liveType;
  if (jobType === 'hourly') {
    const live = parseBudget('hourly', input.liveBudget ?? undefined);
    const liveClient = live?.kind === 'hourly' ? computeBid('hourly', input.liveBudget, input.settings) : null;
    if (input.bid != null && input.bidBasis !== 'bidder-hourly-usd') return { jobType, bid: input.bid, basis: 'stored', hold: null };
    if (liveClient && (input.bid == null || input.bidBasis === 'bidder-hourly-usd')) return { jobType, bid: liveClient, basis: 'client', hold: null };
    if (input.bid != null) return { jobType, bid: input.bid, basis: 'bidder-hourly-usd', hold: null };
    return { jobType, bid: BIDDER_HOURLY_USD, basis: 'bidder-hourly-usd', hold: null };
  }
  if (jobType === 'fixed') {
    if (input.bid != null) return { jobType, bid: input.bid, basis: 'stored', hold: null };
    const live = parseBudget('fixed', input.liveBudget ?? undefined);
    if (live?.kind === 'fixed' && live.amount > 0) return { jobType, bid: live.amount, basis: 'client', hold: null };
    return { jobType, bid: null, basis: 'stored', hold: FIXED_AMOUNT_MESSAGE };
  }
  return { jobType: null, bid: input.bid, basis: 'stored', hold: 'Not sent: the job type was not in the saved snapshot or the job read. No rate was assumed.' };
}

export interface Answer { question: string; answer: string }
export function checkAnswers(questions: string[], answers: Answer[]): string | null {
  if (answers.length !== questions.length) return `expected ${questions.length} answers, got ${answers.length}`;
  for (const a of answers) {
    const t = a.answer.trim();
    if (!t) return 'an answer is empty';
    if (t.length > 2000) return 'an answer is longer than 2,000 characters';
    const p = problemsInWritten(t);
    if (p) return `an answer contains ${p}`;
  }
  return null;
}

// Bid from Siv's rules (BUILD_PLAN §11a): hourly = top of the client's range, else the profile rate; fixed = the budget.
export function computeBid(jobType: string | null, budget: string | null, s: Settings): number | null {
  const b = parseBudget(jobType ?? undefined, budget ?? undefined);
  const profile = s.bid.profileRate > 0 ? s.bid.profileRate : null;
  if (jobType === 'hourly' || b?.kind === 'hourly') {
    const top = b?.kind === 'hourly' ? (b.max ?? b.min) : null;
    const bid = s.bid.hourly === 'client_max' ? (top ?? profile) : (profile ?? top);
    return bid && bid > 0 ? Math.round(bid * 100) / 100 : null;
  }
  if (b?.kind !== 'fixed' || !(b.amount > 0)) return null;
  const amount = s.bid.fixed === 'budget_plus_10' ? b.amount * 1.1 : b.amount;
  return Math.round(amount * 100) / 100;
}
