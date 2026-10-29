import { describe, expect, it } from 'vitest';
import { boostBid, isBoostRefusal, readBoost, type BoostInfo } from '../src/pipeline/sendRules';
import { DEFAULT_SETTINGS, validateSettings, type Settings } from '../src/settings';

// Siv, Oct 27: boost proposals with a match score of 75+, at Upwork's recommended bid, up to a max per job.
// Celia, Oct 29: in Auto-submit only, on as soon as Auto is on.
const s = (caps: Partial<Settings['caps']> = {}): Settings => {
  const base = structuredClone(DEFAULT_SETTINGS);
  return { ...base, caps: { ...base.caps, boostInAuto: true, boostMinScore: 75, boostMaxConnects: 20, ...caps } };
};
const open: BoostInfo = { available: true, recommended: 3, max: 600, skip: false };

describe('readBoost (the preview\'s boost block)', () => {
  it('reads the fields Upwork documents', () => {
    expect(readBoost({ available: true, current_top_bids: [5, 3], recommended_connects: 6, max_boost_connects: 640, recommendation: 'boost' }))
      .toEqual({ available: true, recommended: 6, max: 640, skip: false });
    expect(readBoost({ available: false, reason: 'preferred qualifications' })).toEqual({ available: false, recommended: null, max: null, skip: false });
    expect(readBoost({ available: true, recommended_connects: 1, recommendation: 'Skip' })?.skip).toBe(true);
    expect(readBoost(undefined)).toBeNull();
    expect(readBoost([1, 2])).toBeNull();
  });
});

describe('boostBid', () => {
  it('bids the recommended Connects on strong matches only', () => {
    expect(boostBid(80, open, s(), 600, 'auto')).toBe(3);
    expect(boostBid(75, open, s(), 600, 'auto')).toBe(3);
    expect(boostBid(74, open, s(), 600, 'auto')).toBeNull();
    expect(boostBid(null, open, s(), 600, 'auto')).toBeNull();
  });
  it('boosts in Auto-submit only, and not when switched off', () => {
    expect(DEFAULT_SETTINGS.caps.boostInAuto).toBe(true); // on as soon as Auto is on
    expect(boostBid(95, open, s(), 600, 'review')).toBeNull(); // proposals sent from Review first are never boosted
    expect(boostBid(95, open, s({ boostInAuto: false }), 600, 'auto')).toBeNull();
  });
  it('skips when Upwork says no boost or the top slot costs more than allowed', () => {
    expect(boostBid(90, { ...open, available: false }, s(), 600, 'auto')).toBeNull();
    expect(boostBid(90, { ...open, skip: true }, s(), 600, 'auto')).toBeNull();
    expect(boostBid(90, { ...open, recommended: null }, s(), 600, 'auto')).toBeNull();
    expect(boostBid(90, { ...open, recommended: 21 }, s(), 600, 'auto')).toBeNull();
    expect(boostBid(90, { ...open, recommended: 20 }, s(), 600, 'auto')).toBe(20);
    expect(boostBid(90, { ...open, recommended: 0 }, s(), 600, 'auto')).toBe(1); // Upwork's minimum bid is 1
  });
  it('stays within the balance left after the job and the Connects floor', () => {
    expect(boostBid(90, { ...open, max: 2 }, s(), 600, 'auto')).toBeNull();
    expect(boostBid(90, open, s(), 2, 'auto')).toBeNull();
    expect(boostBid(90, open, s(), null, 'auto')).toBe(3);
    expect(boostBid(90, open, s({ connectsFloorEnabled: true, connectsFloor: 20 }), 22, 'auto')).toBeNull(); // 22 - 20 leaves room for 2, the bid is 3
    expect(boostBid(90, open, s({ connectsFloorEnabled: true, connectsFloor: 20 }), 23, 'auto')).toBe(3);
  });
});

describe('isBoostRefusal', () => {
  it('spots Upwork refusing an outbid boost', () => {
    expect(isBoostRefusal('The boost bid no longer takes a paid slot. Bids to beat: 7, 5')).toBe(true);
    expect(isBoostRefusal('Job is closed')).toBe(false);
  });
});

describe('boost settings', () => {
  it('replaces the old boost menu and validates the new fields', () => {
    // Settings saved before Oct 29 carry boostEnabled: false (the old default); the new switch starts on.
    const old = { ...DEFAULT_SETTINGS, caps: { ...DEFAULT_SETTINGS.caps, boost: 'never', boostEnabled: false } };
    const v = validateSettings(old);
    expect(v.caps).not.toHaveProperty('boost');
    expect(v.caps).not.toHaveProperty('boostEnabled');
    expect(v.caps.boostInAuto).toBe(true);
    expect(v.caps.boostMinScore).toBe(75);
    expect(v.caps.boostMaxConnects).toBe(20);
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, caps: { ...DEFAULT_SETTINGS.caps, boostMaxConnects: 0 } })).toThrow('Boost');
  });
});
