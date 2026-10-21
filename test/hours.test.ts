import { describe, expect, it } from 'vitest';
import { isActiveNow } from '../src/api';

const at = (iso: string) => new Date(iso);

describe('isActiveNow', () => {
  it('treats equal start and end as all day', () => {
    expect(isActiveNow('00:00', '00:00', 'America/Los_Angeles', at('2026-10-21T18:09:00Z'))).toBe(true);
    expect(isActiveNow('09:00', '09:00', 'America/Los_Angeles', at('2026-10-21T03:00:00Z'))).toBe(true);
  });
  it('handles a normal window and one that crosses midnight', () => {
    // 11:09 in Los Angeles (UTC-7 on Oct 21)
    expect(isActiveNow('07:00', '21:00', 'America/Los_Angeles', at('2026-10-21T18:09:00Z'))).toBe(true);
    expect(isActiveNow('07:00', '21:00', 'America/Los_Angeles', at('2026-10-21T05:00:00Z'))).toBe(false);
    expect(isActiveNow('22:00', '06:00', 'America/Los_Angeles', at('2026-10-21T08:00:00Z'))).toBe(true);  // 01:00 local
    expect(isActiveNow('22:00', '06:00', 'America/Los_Angeles', at('2026-10-21T18:00:00Z'))).toBe(false); // 11:00 local
  });
});
