import type { Settings } from '../settings';
import { parseBudget, stripUntrusted } from './filters';

// Pure letter and bid logic: no network. Everything Claude writes passes through these checks before it is stored.

export const MAX_LETTER = 5000;
// Rafa's own hourly rate. Used only when an hourly job has no client band. Never stored as the client budget.
export const BIDDER_HOURLY_USD = 30;
// A fixed-price post with no usable amount is bid as ten hours of that rate. It is an estimate, not a client budget.
export const FIXED_ESTIMATE_USD = BIDDER_HOURLY_USD * 10;
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

const SIGN_OFF_LINE = /^(?:thanks|thank you|best|best regards|regards|sincerely|cheers|talk soon|warmly|all the best)[,!]?\s*$/i;
const SIGN_OFF_WITH_NAME = /^(?:thanks|thank you|best|best regards|regards|sincerely|cheers|talk soon|warmly|all the best),?\s+(?:rafaela eguiguren|rafaela|rafa)[.!]?$/i;
const NAME_ONLY = /^(?:rafaela eguiguren|rafaela|rafa)[.!]?$/i;
const SELF_NAME = '\\b(?:Rafaela(?:\\s+Eguiguren)?|Rafa)(?!@)';

// The closing name is the one place the letter may say Rafa. Everything above it is the voice of the letter.
export function letterBody(text: string): string {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  if (end === 0) return text;
  const last = lines[end - 1].trim();
  if (SIGN_OFF_WITH_NAME.test(last)) return lines.slice(0, end - 1).join('\n');
  if (!NAME_ONLY.test(last)) return text;
  let start = end - 1;
  let cursor = start;
  while (cursor > 0 && !lines[cursor - 1].trim()) cursor--;
  if (cursor > 0 && SIGN_OFF_LINE.test(lines[cursor - 1].trim())) start = cursor - 1;
  return lines.slice(0, start).join('\n');
}

function letterSignOff(text: string): string {
  const body = letterBody(text);
  return body === text ? '' : text.slice(body.length);
}

// "Rafa would", "Rafa has", "Rafaela's", "Rafa will". A sign-off, or "I'm Rafa", is not third person.
export function thirdPersonIn(text: string): string | null {
  const body = letterBody(text).replace(new RegExp(`\\b(?:I['’]?m|I am|my name is)\\s+${SELF_NAME}\\b`, 'gi'), '');
  return new RegExp(`${SELF_NAME}(?:['’]s)?\\b`, 'i').test(body) ? 'third person' : null;
}

const VERB_AS_I: Record<string, string> = { has: 'have', is: 'am', does: 'do' };

// Local repair used when the model rewrite is missing or still talks about Rafa. It never drops the sign-off.
export function toFirstPerson(text: string): string {
  const signOff = letterSignOff(text);
  let body = letterBody(text);
  const kept: string[] = [];
  body = body.replace(new RegExp(`\\b(?:I['’]?m|I am|my name is)\\s+${SELF_NAME}\\b`, 'gi'), (match) => {
    kept.push(match);
    return `\u0000${kept.length - 1}\u0000`;
  });
  body = body.replace(new RegExp(`${SELF_NAME}['’]s\\b`, 'gi'), 'my');
  body = body.replace(new RegExp(`${SELF_NAME}\\b(\\s+)(would|will|can|could|should|might|may|has|had|is|was|does|did)\\b`, 'gi'), (_match, space: string, verb: string) => {
    const lower = verb.toLowerCase();
    const fixed = VERB_AS_I[lower] ?? lower;
    const cased = verb[0] === verb[0].toUpperCase() ? fixed[0].toUpperCase() + fixed.slice(1) : fixed;
    return `I${space}${cased}`;
  });
  body = body.replace(new RegExp(`${SELF_NAME}\\b`, 'gi'), 'I');
  body = body.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => kept[Number(index)]);
  body = body.replace(/\bI has\b/g, 'I have').replace(/\bI is\b/g, 'I am').replace(/\bI does\b/g, 'I do');
  return `${body}${signOff}`;
}

export const FIRST_PERSON_PROBLEM = 'third-person references to Rafa (for example "Rafa would" or "Rafaela\'s"). Rewrite those to first person (I, me, my). Leave a sign-off that is only her name.';

// Same shape as the internal-wording rewrite: ask once, then repair locally. A failed rewrite does not hold the send.
export async function repairFirstPerson(text: string, rewrite?: (text: string, problem: string) => Promise<string>): Promise<string> {
  if (!thirdPersonIn(text)) return text;
  if (rewrite) {
    try {
      const cleaned = (await rewrite(text, FIRST_PERSON_PROBLEM))?.trim();
      if (cleaned && !thirdPersonIn(cleaned)) return cleaned;
    } catch { /* the local repair still sends */ }
  }
  return toFirstPerson(text);
}

export function checkOpening(opening: string): string | null {
  const t = opening.trim();
  if (t.length < 25) return 'the opening is too short';
  if (t.length > MAX_OPENING) return `the opening is longer than ${MAX_OPENING} characters`;
  if (thirdPersonIn(t)) return 'the opening refers to Rafa in the third person';
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

// The sender already reads contract terms. A missing type is hourly at Rafa's rate. A fixed price with no usable
// amount uses the ten-hour estimate. Neither case holds the send.
export function resolveSendBid(input: {
  jobType: string | null;
  bid: number | null;
  bidBasis: string | null;
  liveType: 'fixed' | 'hourly' | null;
  liveBudget: string | null;
  settings: Settings;
}): { jobType: 'fixed' | 'hourly'; bid: number; basis: 'stored' | 'client' | 'bidder-hourly-usd' | 'inferred-fixed-usd'; hold: null } {
  const jobType = input.jobType === 'fixed' || input.jobType === 'hourly' ? input.jobType : (input.liveType ?? 'hourly');
  if (jobType === 'hourly') {
    const live = parseBudget('hourly', input.liveBudget ?? undefined);
    const liveClient = live?.kind === 'hourly' ? computeBid('hourly', input.liveBudget, input.settings) : null;
    if (input.bid != null && input.bidBasis !== 'bidder-hourly-usd') return { jobType, bid: input.bid, basis: 'stored', hold: null };
    if (liveClient && (input.bid == null || input.bidBasis === 'bidder-hourly-usd')) return { jobType, bid: liveClient, basis: 'client', hold: null };
    if (input.bid != null) return { jobType, bid: input.bid, basis: 'bidder-hourly-usd', hold: null };
    return { jobType, bid: BIDDER_HOURLY_USD, basis: 'bidder-hourly-usd', hold: null };
  }
  if (input.bid != null) return { jobType, bid: input.bid, basis: 'stored', hold: null };
  const live = parseBudget('fixed', input.liveBudget ?? undefined);
  if (live?.kind === 'fixed' && live.amount > 0) return { jobType, bid: live.amount, basis: 'client', hold: null };
  return { jobType, bid: FIXED_ESTIMATE_USD, basis: 'inferred-fixed-usd', hold: null };
}

export interface Answer { question: string; answer: string }

// The model sometimes explains its own limits ("I can't paste links here"). That is internal wording, not an answer.
const ANSWER_META = /can(?:not|'t|’t)\s+paste\s+links|paste links here|i can(?:not|'t|’t)\s+paste\b/i;
export const NATURAL_SCREENING_ANSWER = 'I can share examples of that work on a call or in a message.';

export function screeningAnswerProblem(answer: string): string | null {
  if (metaLanguageIn(answer) || ANSWER_META.test(answer)) return 'internal wording';
  return null;
}

export function cleanScreeningAnswer(answer: string): string {
  const text = answer.trim();
  if (!text) return text;
  if (screeningAnswerProblem(text)) return NATURAL_SCREENING_ANSWER;
  return toFirstPerson(text);
}

export function checkAnswers(questions: string[], answers: Answer[]): string | null {
  if (answers.length !== questions.length) return `expected ${questions.length} answers, got ${answers.length}`;
  for (const a of answers) {
    const t = a.answer.trim();
    if (!t) return 'an answer is empty';
    if (t.length > 2000) return 'an answer is longer than 2,000 characters';
    if (screeningAnswerProblem(t)) return 'an answer contains internal wording';
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
