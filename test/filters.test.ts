import { describe, expect, it } from 'vitest';
import { connectsOverLimit, containsTerm, evaluateJob, normalizeCountry, parseBudget, recheckStored, stripUntrusted, tierLowerBound, type UpworkJob } from '../src/pipeline/filters';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

// Siv's answers (BUILD_PLAN §11a): Klaviyo in title or description, US/CA/UK clients, no other filters.
const siv: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  keywords: ['Klaviyo'], titleOnly: false, exclude: [], minFixedBudget: 0, minHourlyRate: 0,
  verifiedOnly: false, maxExistingProposals: 0, allowedCountries: ['United States', 'Canada', 'United Kingdom'],
};

const job = (over: Partial<UpworkJob> = {}): UpworkJob => ({
  id: '2112916206625611801',
  title: 'Klaviyo email flows for a DTC brand',
  job_type: 'hourly',
  budget: '10.00–30.00/hr',
  client: { country: 'United States', verification_status: 'VERIFIED' },
  proposals_tier: '15 to 20',
  description_snippet: '<untrusted_participant_content>\nWe need flows.\n</untrusted_participant_content>',
  ...over,
});

describe('evaluateJob', () => {
  it('matches a Klaviyo title from an allowed country', () => {
    expect(evaluateJob(job(), siv, new Set())).toEqual({ status: 'matched', keywords: ['Klaviyo'] });
  });

  it('matches when Klaviyo is only in the description', () => {
    const v = evaluateJob(job({ title: 'Email marketer for Shopify store', description: '<untrusted_participant_content>Must know klaviyo.</untrusted_participant_content>' }), siv, new Set());
    expect(v.status).toBe('matched');
  });

  it('drops broad-query results that never name the keyword', () => {
    const v = evaluateJob(job({ title: 'Email marketer', description: 'Mailchimp and Omnisend work.' }), siv, new Set());
    expect(v).toMatchObject({ status: 'filtered', reason: 'No keyword in the title or description' });
  });

  it('respects title-only matching', () => {
    const v = evaluateJob(job({ title: 'Email marketer', description: 'Klaviyo' }), { ...siv, titleOnly: true }, new Set());
    expect(v).toMatchObject({ status: 'filtered', reason: 'No keyword in the title' });
  });

  it('filters clients outside the allowed countries, and keeps aliases working', () => {
    expect(evaluateJob(job({ client: { country: 'Pakistan' } }), siv, new Set())).toMatchObject({ status: 'filtered', reason: 'Client country: Pakistan' });
    expect(evaluateJob(job({ client: { country: 'United Kingdom' } }), { ...siv, allowedCountries: ['UK'] }, new Set()).status).toBe('matched');
    expect(evaluateJob(job({ client: {} }), siv, new Set())).toMatchObject({ reason: 'Client country unknown' });
    expect(evaluateJob(job({ client: { country: 'Pakistan' } }), { ...siv, allowedCountries: [] }, new Set()).status).toBe('matched');
  });

  it('skips jobs already applied to or with an invitation', () => {
    expect(evaluateJob(job({ applied: true }), siv, new Set())).toMatchObject({ reason: 'Already applied' });
    expect(evaluateJob(job(), siv, new Set(['2112916206625611801']))).toMatchObject({ reason: 'Invited: answer the invitation on Upwork' });
  });

  it('applies exclusions to title and description', () => {
    const v = evaluateJob(job({ description: 'Also needs WordPress work' }), { ...siv, exclude: ['wordpress'] }, new Set());
    expect(v).toMatchObject({ reason: 'Excluded word: wordpress' });
  });

  it('applies budget, rate, verification and proposal limits only when set', () => {
    const strict = { ...siv, minFixedBudget: 150, minHourlyRate: 35, verifiedOnly: true, maxExistingProposals: 10 };
    expect(evaluateJob(job({ job_type: 'fixed', budget: '100.00' }), strict, new Set())).toMatchObject({ reason: 'Budget $100 below $150' });
    expect(evaluateJob(job({ budget: '10.00–30.00/hr', proposals_tier: 'Fewer than 5' }), strict, new Set())).toMatchObject({ reason: 'Rate up to $30/hr below $35/hr' });
    expect(evaluateJob(job({ budget: '30.00+/hr', proposals_tier: 'Fewer than 5' }), strict, new Set()).status).toBe('matched');
    expect(evaluateJob(job({ budget: '40.00–60.00/hr', client: { country: 'Canada', verification_status: 'UNVERIFIED' } }), strict, new Set())).toMatchObject({ reason: 'Client payment not verified' });
    expect(evaluateJob(job({ budget: '40.00–60.00/hr', proposals_tier: '15 to 20' }), strict, new Set())).toMatchObject({ reason: 'Already 15 to 20 proposals' });
    // Siv's settings: none of these apply.
    expect(evaluateJob(job({ job_type: 'fixed', budget: '5.00', proposals_tier: '50+', client: { country: 'Canada' } }), siv, new Set()).status).toBe('matched');
  });
});

describe('helpers', () => {
  it('parses Upwork budget strings', () => {
    expect(parseBudget('hourly', '10.00–30.00/hr')).toEqual({ kind: 'hourly', min: 10, max: 30 });
    expect(parseBudget('hourly', '30.00+/hr')).toEqual({ kind: 'hourly', min: 30, max: null });
    expect(parseBudget('hourly', 'up to 25.00/hr')).toEqual({ kind: 'hourly', min: null, max: 25 });
    expect(parseBudget('fixed', '5.00')).toEqual({ kind: 'fixed', amount: 5 });
    expect(parseBudget('fixed', '$1,500')).toEqual({ kind: 'fixed', amount: 1500 });
    expect(parseBudget('fixed', '')).toBeNull();
  });

  it('reads proposal tiers', () => {
    expect(tierLowerBound('Fewer than 5')).toBe(0);
    expect(tierLowerBound('20 to 50')).toBe(20);
    expect(tierLowerBound('50+')).toBe(50);
    expect(tierLowerBound(undefined)).toBeNull();
  });

  it('matches whole words only, case-insensitively', () => {
    expect(containsTerm('Klaviyo + Website Management', 'klaviyo')).toBe(true);
    expect(containsTerm('KlaviyoPro integration', 'Klaviyo')).toBe(false);
    expect(containsTerm('Set up email   flows', 'email flows')).toBe(true);
  });

  it('normalizes countries and strips untrusted wrappers', () => {
    expect(normalizeCountry('USA')).toBe('united states');
    expect(normalizeCountry(' United  Kingdom ')).toBe('united kingdom');
    expect(stripUntrusted('<untrusted_participant_content>\nHi\n</untrusted_participant_content>')).toBe('Hi');
  });
});

describe('recheckStored', () => {
  const stored = { title: 'Klaviyo Email Marketer Needed', job_type: 'fixed', budget: '10.00', client_country: 'Nigeria' };
  it('filters waiting jobs from countries added later', () => {
    expect(recheckStored(stored, siv)).toBe('Client country: Nigeria');
    expect(recheckStored({ ...stored, client_country: 'Canada' }, siv)).toBeNull();
    expect(recheckStored(stored, { ...siv, allowedCountries: [] })).toBeNull();
  });
  it('applies title exclusions and budget limits', () => {
    expect(recheckStored({ ...stored, client_country: 'Canada', title: 'Klaviyo + WordPress' }, { ...siv, exclude: ['WordPress'] })).toBe('Excluded word: WordPress');
    expect(recheckStored({ ...stored, client_country: 'Canada' }, { ...siv, minFixedBudget: 50 })).toBe('Budget $10 below $50');
  });
});

describe('connectsOverLimit', () => {
  it('only limits when the switch is on', () => {
    expect(connectsOverLimit(24, siv)).toBeNull();
    const on = { ...siv, caps: { ...siv.caps, maxConnectsEnabled: true, maxConnectsPerJob: 16 } };
    expect(connectsOverLimit(24, on)).toBe('Costs 24 Connects (max 16)');
    expect(connectsOverLimit(16, on)).toBeNull();
    expect(connectsOverLimit(null, on)).toBeNull();
  });
});
