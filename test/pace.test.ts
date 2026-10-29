import { describe, expect, it } from 'vitest';
import { sendDue } from '../src/pipeline/pace';

describe('pace (no Upwork search since Oct 30)', () => {
  it('sends at minute 0, 5, 10… in Review and every minute in Auto', () => {
    expect([0, 1, 4, 5, 10, 55, 59].map((m) => sendDue(m, 'review'))).toEqual([true, false, false, true, true, true, false]);
    expect([0, 1, 2, 3, 59].every((m) => sendDue(m, 'auto'))).toBe(true);
  });
});
