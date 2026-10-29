import { describe, expect, it } from 'vitest';
import { jobIdFromUrl, jobUrl } from '../src/pipeline/jobs';
import { readJobPosting } from '../src/pipeline/write';

// Oct 30: Upwork restricted search on Rafa's account; jobs now come in by link.
describe('jobIdFromUrl', () => {
  it('reads the job id from the link shapes Upwork uses', () => {
    expect(jobIdFromUrl('https://www.upwork.com/jobs/~022115559352186121361')).toBe('2115559352186121361');
    expect(jobIdFromUrl('https://www.upwork.com/jobs/~022115559352186121361?utm_campaign=x&utm_source=claude')).toBe('2115559352186121361');
    expect(jobIdFromUrl('https://www.upwork.com/jobs/Klaviyo-Expert-Needed_~022115559352186121361/')).toBe('2115559352186121361');
    expect(jobIdFromUrl('https://www.upwork.com/freelance-jobs/apply/Klaviyo-Expert_~022115559352186121361/')).toBe('2115559352186121361');
    expect(jobIdFromUrl('https://www.upwork.com/nx/search/jobs/details/~022115559352186121361')).toBe('2115559352186121361');
    expect(jobIdFromUrl(' 2115559352186121361 ')).toBe('2115559352186121361');
  });
  it('refuses anything that is not an Upwork job', () => {
    expect(jobIdFromUrl('https://evil.example/jobs/~022115559352186121361')).toBeNull();
    expect(jobIdFromUrl('https://www.upwork.com.evil.example/jobs/~022115559352186121361')).toBeNull();
    expect(jobIdFromUrl('http://www.upwork.com/jobs/~022115559352186121361')).toBeNull();
    expect(jobIdFromUrl('https://www.upwork.com/nx/search/jobs/?q=klaviyo')).toBeNull();
    expect(jobIdFromUrl('not a link')).toBeNull();
    expect(jobUrl('2115559352186121361')).toBe('https://www.upwork.com/jobs/~022115559352186121361');
  });
});

describe('readJobPosting (find_jobs get)', () => {
  it('reads title, type, budget and country from the job page', () => {
    // As returned on Oct 30 (trimmed).
    const fixed = { data: { marketplaceJobPosting: {
      clientCompanyPublic: { country: { name: 'United States' } },
      content: { title: '<untrusted_participant_content>Klaviyo Expert Needed to Set Up a Post-Purchase Email Flow</untrusted_participant_content>' },
      contractTerms: { contractType: 'FIXED', fixedPriceContractTerms: { amount: { currency: 'USD', rawValue: '5.0' } } },
    } } };
    expect(readJobPosting(fixed)).toEqual({ title: 'Klaviyo Expert Needed to Set Up a Post-Purchase Email Flow', jobType: 'fixed', budget: '5.00', country: 'United States' });
    const hourly = (min?: number, max?: number) => ({ data: { marketplaceJobPosting: { contractTerms: { contractType: 'HOURLY', hourlyContractTerms: { hourlyBudgetMin: min, hourlyBudgetMax: max } } } } });
    expect(readJobPosting(hourly(20, 45)).budget).toBe('20.00–45.00/hr');
    expect(readJobPosting(hourly(undefined, 45)).budget).toBe('up to 45.00/hr');
    expect(readJobPosting(hourly(30)).budget).toBe('30.00+/hr');
    expect(readJobPosting(hourly()).budget).toBeNull();
    expect(readJobPosting({})).toEqual({ title: null, jobType: null, budget: null, country: null });
  });
});
