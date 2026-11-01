import type { Mode } from '../settings';

// How often the sender runs. Review: minute 0, 5, 10…; Auto-submit (Siv, Oct 27): every minute, so a proposal goes out
// as soon as it is written (still caps.gapMinutes apart). Discovery runs at :00/:30; the writer runs every minute.
export const sendDue = (minute: number, mode: Mode) => mode === 'auto' || minute % 5 === 0;
