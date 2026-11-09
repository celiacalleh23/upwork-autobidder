import { describe, expect, it } from 'vitest';
import { displayNote } from '../src/pipeline/proposalNote';

const long = `Saved from the public snapshot. Applied status, Connects, balance, boost, and final screening questions are checked on Upwork before anything is sent. Bid USD 30/hour is Rafa's rate because the client stated no hourly rate. It is not the client's budget. Still missing in the source: client hourly rate; applicant count. Approving still sends with the data on this card. An hourly job with no client rate uses Rafa's USD 30/hour. A fixed-price job with no amount needs an amount in Edit. Feed screening questions were missing or empty, so they stay unknown. An AI hint from the feed was stored and was not used as a question.`;

describe('displayNote', () => {
  it('turns the long saved note into one short grey line', () => {
    const note = displayNote({ error: long, status: 'skipped', bidBasis: 'bidder-hourly-usd', missing: ['client-hourly-band-missing', 'applicant-count-missing'] });
    expect(note).toEqual({ text: "Rafa's rate $30/hr · missing: client rate, applicant count", error: false });
    expect(note.text!.length).toBeLessThanOrEqual(80);
  });

  it('reads the same line from the stored text when structured fields are absent', () => {
    expect(displayNote({ error: long, status: 'approved' })).toEqual({ text: "Rafa's rate $30/hr · missing: client rate, applicant count", error: false });
    const onlyHint = 'Saved from the public snapshot. Feed screening questions were missing or empty, so they stay unknown. An AI hint from the feed was stored and was not used as a question.';
    expect(displayNote({ error: onlyHint, status: 'skipped' })).toEqual({ text: null, error: false });
  });

  it('keeps a real failure in full and marked as an error', () => {
    const failed = 'Upwork refused the proposal: the job is closed.';
    expect(displayNote({ error: failed, status: 'failed' })).toEqual({ text: failed, error: true });
    const wording = 'Not sent: the letter contains internal wording.';
    expect(displayNote({ error: wording, status: 'pending' })).toEqual({ text: wording, error: true });
    const amount = 'This fixed-price job has no amount. Set the amount with Edit, then approve. None was invented.';
    expect(displayNote({ error: amount, status: 'pending' }).error).toBe(true);
    const questions = 'Upwork did not return screening questions. Nothing was sent.';
    expect(displayNote({ error: questions, status: 'skipped' })).toEqual({ text: questions, error: true });
  });
});
