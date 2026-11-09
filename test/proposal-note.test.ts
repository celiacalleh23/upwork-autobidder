import { describe, expect, it } from 'vitest';
import { displayNote } from '../src/pipeline/proposalNote';

const long = `Saved from the public snapshot. Applied status, Connects, balance, boost, and final screening questions are checked on Upwork before anything is sent. Bid USD 30/hour is Rafa's rate because the client stated no hourly rate. It is not the client's budget. Still missing in the source: client hourly rate; applicant count. Approving still sends with the data on this card. An hourly job with no client rate uses Rafa's USD 30/hour. A fixed-price job with no amount needs an amount in Edit. Feed screening questions were missing or empty, so they stay unknown. An AI hint from the feed was stored and was not used as a question.`;

describe('displayNote', () => {
  it('hides the long saved note and every missing-data line', () => {
    expect(displayNote({ error: long, status: 'skipped', bidBasis: 'bidder-hourly-usd', missing: ['client-hourly-band-missing', 'applicant-count-missing'] })).toEqual({ text: null, error: false });
    expect(displayNote({ error: long, status: 'approved' })).toEqual({ text: null, error: false });
    const onlyHint = 'Saved from the public snapshot. Feed screening questions were missing or empty, so they stay unknown. An AI hint from the feed was stored and was not used as a question.';
    expect(displayNote({ error: onlyHint, status: 'skipped' })).toEqual({ text: null, error: false });
    expect(displayNote({ error: "Rafa's rate $30/hr · missing: applicant count, description", status: 'pending' })).toEqual({ text: null, error: false });
  });

  it('hides old screening holds and shows one short red sentence for a real failure', () => {
    expect(displayNote({ error: 'Upwork did not return screening questions. Nothing was sent.', status: 'pending' })).toEqual({ text: null, error: false });
    expect(displayNote({ error: 'Upwork now shows 4 screening question(s); review the answers and approve again', status: 'pending' })).toEqual({ text: null, error: false });
    expect(displayNote({ error: 'This fixed-price job has no amount. Set the amount with Edit, then approve. None was invented.', status: 'pending' })).toEqual({ text: null, error: false });
    expect(displayNote({ error: 'Not sent: source data is still missing (applicant count). Approval does not bypass that.', status: 'pending' })).toEqual({ text: null, error: false });
    const failed = 'Upwork refused the proposal: the job is closed.';
    expect(displayNote({ error: failed, status: 'failed' })).toEqual({ text: failed, error: true });
    const wording = 'Not sent: the letter contains internal wording.';
    expect(displayNote({ error: wording, status: 'pending' })).toEqual({ text: wording, error: true });
  });
});
