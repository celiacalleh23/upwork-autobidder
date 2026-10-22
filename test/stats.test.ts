import { describe, expect, it } from 'vitest';
import { parseWhen } from '../src/pipeline/stats';

describe('parseWhen', () => {
  const t = Date.parse('2026-05-01T10:00:00Z');
  it('reads ISO text, epoch seconds and milliseconds, and nested values', () => {
    expect(parseWhen('2026-05-01T10:00:00Z')).toBe(t);
    expect(parseWhen(t)).toBe(t);
    expect(parseWhen(t / 1000)).toBe(t);
    expect(parseWhen(String(t))).toBe(t);
    expect(parseWhen({ rawValue: String(t) })).toBe(t);
    expect(parseWhen({ value: '2026-05-01T10:00:00Z' })).toBe(t);
  });
  it('returns NaN when it cannot read a date', () => {
    expect(parseWhen(undefined)).toBeNaN();
    expect(parseWhen('yesterday-ish')).toBeNaN();
    expect(parseWhen({ foo: 1 })).toBeNaN();
  });
});
