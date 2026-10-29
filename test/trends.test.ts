import { describe, expect, it } from 'vitest';
import { analyzeJobs, parseKeywords, skillTrends, type TrendJob } from '../src/pipeline/trends';

const now = Date.parse('2026-10-29T12:00:00Z');
const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
// Shaped like find_jobs search results on a real account (Oct 29).
const job = (h: number, over: Partial<TrendJob> = {}): TrendJob => ({
  title: '<untrusted_participant_content>Klaviyo Expert Needed</untrusted_participant_content>', url: 'https://www.upwork.com/jobs/~021',
  job_type: 'fixed', budget: '500.00', proposals_tier: '5 to 10', skills: ['Klaviyo', 'Email Marketing', 'Shopify'],
  client: { country: 'United States', verification_status: 'VERIFIED' }, published_date: ago(h), ...over,
});

describe('analyzeJobs', () => {
  it('estimates the pace, competition, budgets and related skills', () => {
    const jobs = [
      job(1), job(3, { proposals_tier: 'Fewer than 5', budget: '5.00' }), job(5, { proposals_tier: '20 to 50', budget: '1,500.00' }),
      job(7, { job_type: 'hourly', budget: '20.00–45.00/hr', skills: ['Klaviyo', 'SMS Marketing'], client: { country: 'CAN', verification_status: 'UNVERIFIED' } }),
      job(11, { job_type: 'hourly', budget: '30.00+/hr', proposals_tier: undefined, skills: ['Email Copywriting'] }),
      job(23, { proposals_tier: '50+' }),
    ];
    const k = analyzeJobs('Klaviyo', 'title', jobs, true, now);
    expect(k.sample).toBe(6);
    expect(k.perDay).toBe(6.3); // 6 jobs over the 23 hours since the oldest
    expect(k.competition).toEqual({ known: 5, under5: 20, under10: 60, over20: 40 });
    expect(k.fixedMedian).toBe(500); // 5, 500, 500, 1500
    expect(k.hourlyMedianTop).toBe(38); // 45 and 30
    expect(k.hourlyShare).toBe(33);
    expect(k.verifiedShare).toBe(83);
    expect(k.skills[0]).toEqual(['Email Marketing', 4]);
    expect(k.skills.map(([s]) => s)).not.toContain('Klaviyo'); // the keyword itself is not a suggestion
    expect(k.countries[0]).toEqual(['United States', 5]);
    expect(k.examples[0].title).toBe('Klaviyo Expert Needed');
  });
  it('drops links that are not Upwork job links and handles no results', () => {
    expect(analyzeJobs('x', 'title', [job(1, { url: 'javascript:alert(1)' })], false, now).examples[0].url).toBeNull();
    const none = analyzeJobs('nothing', 'anywhere', [], false, now);
    expect(none).toMatchObject({ sample: 0, perDay: null, fixedMedian: null, skills: [] });
  });
});

describe('parseKeywords', () => {
  it('splits on commas, trims and drops repeats', () => {
    expect(parseKeywords(' Klaviyo, SMS  marketing,klaviyo ', 'title')).toEqual(['Klaviyo', 'SMS marketing']);
  });
  it('refuses empty, too many and too long input', () => {
    expect(() => parseKeywords('', 'title')).toThrow('at least one');
    expect(() => parseKeywords('a1,b1,c1,d1,e1,f1', 'title')).toThrow('Up to 5');
    expect(() => parseKeywords('x', 'title')).toThrow('2 to 60');
    expect(() => parseKeywords('email marketing for shopify brands', 'title')).toThrow('at most 4 words');
    expect(parseKeywords('email marketing for shopify brands', 'anywhere')).toHaveLength(1);
  });
});

describe('skillTrends', () => {
  it('compares this week with the week before', () => {
    const sql = (h: number) => ago(h).slice(0, 19).replace('T', ' ');
    const rows = [
      { skills: JSON.stringify(['Klaviyo', 'SMS Marketing']), seen_at: sql(2) },
      { skills: JSON.stringify(['Klaviyo']), seen_at: sql(30) },
      { skills: JSON.stringify(['Klaviyo', 'Postscript']), seen_at: sql(8 * 24) },
      { skills: JSON.stringify(['Klaviyo']), seen_at: sql(20 * 24) }, // older than two weeks
      { skills: 'not json', seen_at: sql(1) },
    ];
    const r = skillTrends(rows, now);
    expect(r.jobs).toBe(2);
    expect(r.trends).toEqual([
      { skill: 'Klaviyo', thisWeek: 2, lastWeek: 1 },
      { skill: 'SMS Marketing', thisWeek: 1, lastWeek: 0 },
      { skill: 'Postscript', thisWeek: 0, lastWeek: 1 },
    ]);
  });
});
