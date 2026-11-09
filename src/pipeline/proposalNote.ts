// Turns the long stored proposal note into one short line for the dashboard.
// The database text is left as it was.

const SHORT: Record<string, string> = {
  'description-missing': 'description',
  'description-fragment': 'description',
  'job-type-missing': 'job type',
  'client-hourly-band-missing': 'client rate',
  'client-fixed-amount-missing': 'fixed amount',
  'currency-undocumented': 'currency',
  'explicit-currency-not-usd': 'currency',
  'applicant-count-missing': 'applicant count',
  'verification-missing': 'verification',
};

const PHRASES: [RegExp, string][] = [
  [/full job post \(the stored text is only a snippet\)/i, 'description'],
  [/documented currency for the stated price/i, 'currency'],
  [/a usd client price \(the feed named another currency\)/i, 'currency'],
  [/client payment verification/i, 'verification'],
  [/client hourly rate/i, 'client rate'],
  [/client fixed price/i, 'fixed amount'],
  [/job description/i, 'description'],
  [/applicant count/i, 'applicant count'],
  [/job type/i, 'job type'],
  [/fixed amount/i, 'fixed amount'],
  [/verification/i, 'verification'],
  [/currency/i, 'currency'],
  [/description/i, 'description'],
];

export interface NoteInput {
  error: string | null;
  status?: string | null;
  bidBasis?: string | null;
  missing?: string[] | null;
}

export interface DisplayNote { text: string | null; error: boolean }

const informational = (text: string) => /saved from the public snapshot|still missing in the source|still blank in the source/i.test(text);

export function displayNote(input: NoteInput): DisplayNote {
  const text = (input.error ?? '').trim();
  if (!text) return { text: null, error: false };
  if (input.status === 'failed' || (!informational(text) && /internal wording|set the amount with edit|upwork refused|upwork did not|nothing was sent|not resending|unclear answer|account warning/i.test(text))) {
    return { text, error: true };
  }
  if (!informational(text)) return { text, error: false };
  const rate = input.bidBasis === 'bidder-hourly-usd' || /rafa's rate|usd 30\/hour is rafa/i.test(text);
  const missing = unique([...(input.missing ?? []).map((code) => SHORT[code]).filter(Boolean), ...missingFrom(text)]);
  const parts = [rate ? "Rafa's rate $30/hr" : '', missing.length ? `missing: ${missing.join(', ')}` : ''].filter(Boolean);
  return { text: parts.length ? cap(parts.join(' · '), 80) : null, error: false };
}

function missingFrom(text: string): string[] {
  const found: string[] = [];
  const listed = text.match(/still (?:missing|blank) in the source:\s*([^.]*)/i);
  if (listed) found.push(...labels(listed[1]));
  if (/no job type was stated/i.test(text)) found.push('job type');
  if (/no fixed price was stated/i.test(text)) found.push('fixed amount');
  return found;
}

function labels(list: string): string[] {
  return list.split(/;|,/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const hit = PHRASES.find(([re]) => re.test(part));
    return hit ? hit[1] : part.replace(/\s+/g, ' ').slice(0, 24);
  });
}

function unique(items: string[]): string[] {
  return items.filter((item, i) => items.indexOf(item) === i);
}

function cap(line: string, max: number): string {
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
