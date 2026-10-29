import type { Mode } from '../settings';

// How often the sender runs. Review: minute 0, 5, 10…; Auto-submit (Siv, Oct 27): every minute, so a proposal goes out
// as soon as it is written (still caps.gapMinutes apart). This Worker no longer searches Upwork (Oct 30: search
// restricted on Rafa's account); jobs come in by link (jobs.ts) and the writer runs every minute.
export const sendDue = (minute: number, mode: Mode) => mode === 'auto' || minute % 5 === 0;
