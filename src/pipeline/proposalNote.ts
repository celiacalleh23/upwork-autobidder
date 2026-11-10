// The dashboard shows a note only for a real failure: one short sentence, marked as an error.
// Missing-data text, screening holds, and the old snapshot boilerplate are hidden at read time, including rows already stored.

export interface NoteInput {
  error: string | null;
  status?: string | null;
  bidBasis?: string | null;
  missing?: string[] | null;
}

export interface DisplayNote { text: string | null; error: boolean }

const HIDDEN = /saved from the public snapshot|still missing|still blank|rafa'?s rate|missing:|missing in the source|applicant count|did not return screening|screening question|ai hint from the feed|feed screening|set the amount with edit|none was invented|source data is still missing|no job type was stated|no fixed price was stated|not the client'?s budget|usd 30\/hour|questions were missing|not used as a question|approval does not bypass/i;

const REAL = /upwork refused|upwork asked|account warning|job is closed|no longer available|already applied|not enough connects|connects floor|rate limit|internal wording|letter contains|could not read the connects|unclear|not resending|invited:|interrupted while sending|checking on upwork|the final preview is not eligible|connects over/i;

export function displayNote(input: NoteInput): DisplayNote {
  const text = (input.error ?? '').replace(/\s+/g, ' ').trim();
  if (/^The send stopped before it reached Upwork\.?$/.test(text)) return { text: 'The send stopped before it reached Upwork.', error: false };
  if (!text || HIDDEN.test(text) || !REAL.test(text)) return { text: null, error: false };
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return { text: sentence.length > 180 ? `${sentence.slice(0, 179).trimEnd()}…` : sentence, error: true };
}
