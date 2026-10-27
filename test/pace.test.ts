import { describe, expect, it } from 'vitest';
import { AUTO_SCAN_EVERY_MINUTES, scanEveryMinutes, sendAndScanDue, writeDue } from '../src/pipeline/pace';
import { scanDue } from '../src/pipeline/scan';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

const s = (scanEvery: number): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), scanEveryMinutes: scanEvery });

describe('pace (Siv, Oct 27: faster in Auto mode only)', () => {
  it('scans at the Settings interval in Review and every 2 minutes in Auto', () => {
    expect(scanEveryMinutes('review', s(5))).toBe(5);
    expect(scanEveryMinutes('review', s(15))).toBe(15);
    expect(scanEveryMinutes('auto', s(5))).toBe(AUTO_SCAN_EVERY_MINUTES);
    expect(scanEveryMinutes('auto', s(15))).toBe(2);
  });
  it('sends and scans at minute 0, 5, 10… in Review and every minute in Auto', () => {
    expect([0, 1, 4, 5, 10, 55, 59].map((m) => sendAndScanDue(m, 'review'))).toEqual([true, false, false, true, true, true, false]);
    expect([0, 1, 2, 3, 59].every((m) => sendAndScanDue(m, 'auto'))).toBe(true);
  });
  it('writes at minute 1, 6, 11… in Review and every minute in Auto', () => {
    expect([1, 2, 5, 6, 11, 56, 59].map((m) => writeDue(m, 'review'))).toEqual([true, false, false, true, true, true, false]);
    expect([1, 2, 3, 59].every((m) => writeDue(m, 'auto'))).toBe(true);
  });
  it('with the every-minute cron, an Auto scan comes due 2 minutes after the last one', () => {
    const last = '2026-10-27T15:00:05Z';
    expect(scanDue(last, scanEveryMinutes('auto', s(5)), Date.parse('2026-10-27T15:01:00Z'))).toBe(false);
    expect(scanDue(last, scanEveryMinutes('auto', s(5)), Date.parse('2026-10-27T15:02:00Z'))).toBe(true);
    // Review keeps 5 minutes: not due at minute 2 even if the cron runs.
    expect(scanDue(last, scanEveryMinutes('review', s(5)), Date.parse('2026-10-27T15:02:00Z'))).toBe(false);
  });
});
