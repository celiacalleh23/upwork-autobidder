import { describe, expect, it } from 'vitest';
import { buildReport, localDay, reportDue, type ReportData } from '../src/pipeline/report';
import { DEFAULT_SETTINGS, reportEmails, validateSettings, type Settings } from '../src/settings';

const s = (over: Partial<Settings['report']> = {}): Settings => {
  const b = structuredClone(DEFAULT_SETTINGS);
  return { ...b, caps: { ...b.caps, timezone: 'America/Los_Angeles' }, report: { ...b.report, ...over } };
};

describe('report schedule', () => {
  it('reads the day and hour in Pacific time', () => {
    expect(localDay('America/Los_Angeles', new Date('2026-10-26T22:30:00Z'))).toMatchObject({ date: '2026-10-26', hour: 15 });
    expect(localDay('America/Los_Angeles', new Date('2026-10-27T06:30:00Z'))).toMatchObject({ date: '2026-10-26', hour: 23 });
  });
  it('is due once a day from 3 pm Pacific', () => {
    expect(reportDue(s(), null, new Date('2026-10-26T21:55:00Z'))).toBe(false); // 2:55 pm
    expect(reportDue(s(), null, new Date('2026-10-26T22:00:00Z'))).toBe(true);  // 3:00 pm
    expect(reportDue(s(), '2026-10-26', new Date('2026-10-26T23:00:00Z'))).toBe(false);
    expect(reportDue(s(), '2026-10-26', new Date('2026-10-27T22:05:00Z'))).toBe(true); // next day
  });
});

describe('report emails', () => {
  it('accepts up to 3 addresses and lists them', () => {
    const v = validateSettings({ ...DEFAULT_SETTINGS, report: { email: 'siv@ltv-labs.com,  celia@example.com', hour: 15 } });
    expect(v.report.email).toBe('siv@ltv-labs.com, celia@example.com');
    expect(reportEmails(v)).toEqual(['siv@ltv-labs.com', 'celia@example.com']);
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, report: { email: 'a@b.co, c@d.co, e@f.co, g@h.co', hour: 15 } })).toThrow('at most 3');
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, report: { email: 'siv@', hour: 15 } })).toThrow('"siv@" is not a valid');
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, report: { email: '', hour: 24 } })).toThrow('Report time');
  });
});

describe('buildReport', () => {
  const base: ReportData = {
    dateLabel: 'Mon, Oct 26', timeZone: 'America/Los_Angeles', now: '2026-10-26T22:00:00.000Z',
    sent: [
      { title: 'Klaviyo <Expert> Needed', url: 'https://www.upwork.com/jobs/~021', submittedAt: '2026-10-26T00:15:00.000Z', postedAt: '2026-10-25T13:37:00.000Z', connects: 8, bid: 45, jobType: 'hourly', loomUrl: 'https://www.loom.com/share/abc' },
      { title: 'Flows audit', url: null, submittedAt: '2026-10-26T18:00:00.000Z', postedAt: '2026-10-26T17:50:00.000Z', connects: 12, bid: 400, jobType: 'fixed', loomUrl: null },
    ],
    failed: [{ title: 'Old job', url: null, status: 'failed', error: 'Job closed on Upwork (no longer takes proposals)' }],
    waiting: 3, approved: 2, scanned: 40, matched: 9, balance: 652, alertBelow: 250,
    mode: 'review', sendingEnabled: true, paused: null, loom: { connected: true, expiresAt: '2026-11-21T00:00:00.000Z' },
  };
  it('sums Connects, shows speed and escapes job titles in HTML', () => {
    const r = buildReport(base);
    expect(r.subject).toBe('Upwork report Mon, Oct 26: 2 sent, 20 Connects');
    expect(r.text).toContain('Sent today: 2 · Connects spent: 20');
    expect(r.text).toContain('10 h 38 min after posting');
    expect(r.text).toContain('Old job: Job closed on Upwork');
    expect(r.html).toContain('Klaviyo &lt;Expert&gt; Needed');
    expect(r.html).not.toContain('<Expert>');
  });
  it('flags a low balance, a pause and a disconnected Loom', () => {
    const r = buildReport({ ...base, sent: [], balance: 120, paused: 'Upwork rate limit', loom: { connected: false, expiresAt: null } });
    expect(r.text).toContain('No proposals sent today.');
    expect(r.text).toContain('below 250, buy more');
    expect(r.text).toContain('PAUSED: Upwork rate limit');
    expect(r.text).toContain('Loom: NOT connected');
  });
});
