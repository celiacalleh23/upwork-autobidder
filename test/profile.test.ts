import { describe, expect, it } from 'vitest';
import { claimsFromTemplate, profileForClaude, syncDue, weightedScore, winsForClaude, winsFrom, type TrackRecord } from '../src/pipeline/profile';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

const s = (over: Partial<Settings> = {}): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), ...over });
const TEMPLATE = `Hi there,

{opening}

I recorded a quick Loom for you: {loom_link}

With my 9+ years of Klaviyo knowledge & expertise, I consistently help brands drive 30-50% of their TOTAL store revenue from email alone.

My Visual Flow Framework
https://miro.com/app/board/uXjVJnINQFw=/

Talk soon,
Rafa`;

const record: TrackRecord = {
  syncedAt: '2026-10-22T10:00:00Z', title: 'Klaviyo Email Marketing Expert', overview: 'I build flows that sell.',
  skills: ['Klaviyo', 'Email Marketing'], hourlyRate: 75, totalJobs: 42,
  wins: [{ title: 'Klaviyo flows for a skincare brand', when: '2026-05-01', feedback: 'Doubled our email revenue', source: 'contract' }],
};

describe('weightedScore', () => {
  it('weighs past wins 90% and profile 10% by default', () => {
    expect(weightedScore(40, 90, s())).toBe(85);
    expect(weightedScore(100, 0, s())).toBe(10);
  });
  it('uses the profile fit alone when there are no past wins', () => {
    expect(weightedScore(70, null, s())).toBe(70);
  });
  it('follows the weights from Settings', () => {
    expect(weightedScore(40, 90, s({ scoreWeights: { profile: 50, wins: 50 } }))).toBe(65);
  });
});

describe('profile for Claude', () => {
  it('keeps the template claims but drops placeholders and links', () => {
    const c = claimsFromTemplate(TEMPLATE);
    expect(c).toContain('9+ years of Klaviyo');
    expect(c).not.toContain('{opening}');
    expect(c).not.toContain('loom');
    expect(c).not.toContain('miro.com');
  });
  it('combines the Upwork profile, the letter claims and Siv\'s notes', () => {
    const text = profileForClaude(record, s({ letter: { template: TEMPLATE, rules: '' }, profileSummary: 'Prefers DTC brands.' }));
    expect(text).toContain('Title: Klaviyo Email Marketing Expert');
    expect(text).toContain('Completed Upwork jobs: 42');
    expect(text).toContain('9+ years of Klaviyo');
    expect(text).toContain('Notes from Siv:\nPrefers DTC brands.');
  });
  it('works before the first sync', () => {
    expect(profileForClaude(null, s({ letter: { template: TEMPLATE, rules: '' } }))).toContain('9+ years of Klaviyo');
    expect(profileForClaude(null, s())).toBe('(no profile information yet)');
  });
  it('lists past wins with their feedback', () => {
    expect(winsForClaude(record)).toBe('- Klaviyo flows for a skincare brand (completed job, 2026-05-01) · client feedback: "Doubled our email revenue"');
    expect(winsForClaude(null)).toBe('');
  });
});

describe('winsFrom', () => {
  it('reads titles, dates and feedback from differently shaped rows, stripping wrappers', () => {
    const rows = [
      { title: '<untrusted_participant_content>\nKlaviyo audit\n</untrusted_participant_content>', end_date: '2026-03-04T00:00:00Z', client_feedback: { comment: 'Great work' } },
      { job: { jobTitle: 'Email flows rebuild' }, client_feedback: 'Fast and clear' },
      { nothing: true },
    ];
    expect(winsFrom(rows, 'contract')).toEqual([
      { title: 'Klaviyo audit', when: '2026-03-04', feedback: 'Great work', source: 'contract' },
      { title: 'Email flows rebuild', when: null, feedback: 'Fast and clear', source: 'contract' },
    ]);
  });
});

describe('syncDue', () => {
  it('syncs every other day', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(syncDue(null, now)).toBe(true);
    expect(syncDue('2026-10-23T12:00:00Z', now)).toBe(false); // 1 day
    expect(syncDue('2026-10-22T12:00:00Z', now)).toBe(true);  // 2 days
  });
});
