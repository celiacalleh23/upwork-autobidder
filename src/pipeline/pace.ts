import type { Mode, Settings } from '../settings';

// How often each part runs. Review keeps the 5-minute rhythm. Auto-submit runs faster (Siv, Oct 27): it scans every
// 2 minutes, writes as soon as a scan finds a job, sends each proposal as soon as it is written (still caps.gapMinutes
// apart) and sends the newest job first. Each part keeps its own cron run, so each gets its own Workers limits.

export const AUTO_SCAN_EVERY_MINUTES = 2;

export function scanEveryMinutes(mode: Mode, s: Settings): number {
  return mode === 'auto' ? Math.min(s.scanEveryMinutes, AUTO_SCAN_EVERY_MINUTES) : s.scanEveryMinutes;
}

// The every-minute cron: send, then scan (when its interval is up). Every minute in Auto; minute 0, 5, 10… in Review.
export const sendAndScanDue = (minute: number, mode: Mode) => mode === 'auto' || minute % 5 === 0;

// The writer cron (minutes 1–59): every minute in Auto; minute 1, 6, 11… in Review.
export const writeDue = (minute: number, mode: Mode) => mode === 'auto' || minute % 5 === 1;
