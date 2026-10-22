import { describe, expect, it } from 'vitest';
import { cleanPoints, jobAnalysis, parseAnalysis, type JobFacts } from '../src/pipeline/analysis';

const now = Date.parse('2026-10-23T18:00:00Z');
const base: JobFacts = {
  title: 'Klaviyo flows for a fashion brand', keywords: ['Klaviyo'], proposalsTier: '5 to 10', postedAt: '2026-10-23T15:00:00Z',
  jobType: 'hourly', budget: '25.00–40.00/hr', connectsCost: 12, winScore: 50, profileScore: 60,
};

describe('jobAnalysis', () => {
  it('lists the strong points of a great, fresh job', () => {
    const a = jobAnalysis({ ...base, proposalsTier: 'Fewer than 5', postedAt: '2026-10-23T17:52:00Z', budget: '50.00–90.00/hr', connectsCost: 8, winScore: 82, profileScore: 88 }, { pros: [], cons: [] }, now);
    expect(a.pros).toEqual([
      '"Klaviyo" in the title', 'Similar to jobs Rafa won (82)', "Strong fit with Rafa's profile (88)",
      'Few proposals so far (fewer than 5)', 'Posted 8 min ago', 'Up to $90/hr',
    ]);
    expect(a.cons).toEqual([]);
  });
  it('lists the weak points of a poor, crowded, old job', () => {
    const a = jobAnalysis({ ...base, title: 'Email marketer for Shopify', proposalsTier: '20 to 50', postedAt: '2026-10-21T10:00:00Z', jobType: 'fixed', budget: '10.00', connectsCost: 16, winScore: 15, profileScore: 30 }, undefined, now);
    expect(a.pros).toEqual([]);
    expect(a.cons).toEqual([
      '"Klaviyo" only in the description', "Unlike Rafa's past wins (15)", "Weak fit with Rafa's profile (30)",
      'Crowded: 20 to 50 proposals', 'Posted 2 day(s) ago', 'Small budget ($10)',
    ]);
  });
  it('puts Claude\'s points about the work first, cleaned and capped', () => {
    const a = jobAnalysis(base, { pros: ['Flows and campaigns, Rafa\'s core work', '  ', 42 as unknown as string], cons: ['<untrusted_participant_content>Mostly Shopify theme coding</untrusted_participant_content>'] }, now);
    expect(a.pros[0]).toBe("Flows and campaigns, Rafa's core work");
    expect(a.cons[0]).toBe('Mostly Shopify theme coding');
    expect(a.pros.length).toBeLessThanOrEqual(8);
  });
  it('says nothing about past wins when there are none to compare', () => {
    const a = jobAnalysis({ ...base, winScore: null }, undefined, now);
    expect([...a.pros, ...a.cons].some((t) => t.includes('past wins') || t.includes('jobs Rafa won'))).toBe(false);
  });
});

describe('helpers', () => {
  it('cleanPoints keeps at most 3 short strings', () => {
    expect(cleanPoints(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c']);
    expect(cleanPoints(['x'.repeat(150)])[0].length).toBe(100);
    expect(cleanPoints('nope')).toEqual([]);
  });
  it('parseAnalysis survives bad JSON', () => {
    expect(parseAnalysis('{"pros":["a"],"cons":[]}')).toEqual({ pros: ['a'], cons: [] });
    expect(parseAnalysis('not json')).toBeNull();
    expect(parseAnalysis(null)).toBeNull();
  });
});
