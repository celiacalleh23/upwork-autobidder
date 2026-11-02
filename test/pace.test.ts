import { describe, expect, it } from 'vitest';
import { sendDue } from '../src/pipeline/pace';

describe('pace (no Upwork search since Oct 30)', () => {
  it('sends at minute 0, 5, 10… in Review and every minute in Auto', () => {
    expect([0, 1, 4, 5, 10, 55, 59].map((m) => sendDue(m, 'review'))).toEqual([true, false, false, true, true, true, false]);
    expect([0, 1, 2, 3, 59].every((m) => sendDue(m, 'auto'))).toBe(true);
  });
});

import { afterEach, vi } from 'vitest';
import { autoSendWait } from '../src/pipeline/pace';
import { DEFAULT_STATE, DEFAULT_SETTINGS, patchState } from '../src/settings';
import { environment } from './support/db';
import { runSender } from '../src/pipeline/send';
import * as oauth from '../src/oauth';
const dbs: ReturnType<typeof environment>[]=[];
const env=()=>{const e=environment();dbs.push(e);return e;};
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();dbs.splice(0).forEach(e=>e.sqlite.close());});
it('keeps the chosen wait stable across ticks and selects a new interval after another send',async()=>{
  const e=env(); const at=Date.parse('2026-11-02T12:00:00Z');
  const st={...structuredClone(DEFAULT_STATE),mode:'auto' as const,lastSendAt:new Date(at).toISOString()};
  const random=vi.spyOn(Math,'random').mockReturnValueOnce(0.999).mockReturnValueOnce(0);
  expect(await autoSendWait(e,st,at+5*60000)).toContain('11 min');
  expect(await autoSendWait(e,st,at+15*60000)).toContain('1 min');
  expect(await autoSendWait(e,st,at+16*60000)).toBeNull();
  expect(random).toHaveBeenCalledTimes(1);
  st.lastSendAt=new Date(at+16*60000).toISOString();
  expect(await autoSendWait(e,st,at+20*60000)).toContain('1 min');
  expect(await autoSendWait(e,st,at+21*60000)).toBeNull();
  expect(random).toHaveBeenCalledTimes(2);
});
it('does not delay Review or the first ever send',async()=>{
  const e=env(); const random=vi.spyOn(Math,'random');
  expect(await autoSendWait(e,{...structuredClone(DEFAULT_STATE),mode:'review',lastSendAt:new Date().toISOString()})).toBeNull();
  expect(await autoSendWait(e,{...structuredClone(DEFAULT_STATE),mode:'auto'})).toBeNull();
  expect(random).not.toHaveBeenCalled();
});
it('blocks the actual sender before any Upwork request during its random wait',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-02T12:06:00Z'));
  const e=env();vi.spyOn(Math,'random').mockReturnValue(0.999);
  await patchState(e,{mode:'auto',paused:false,lastSendAt:'2026-11-02T12:00:00Z',upwork:{connected:true,orgUid:'primary'}});
  const s={...structuredClone(DEFAULT_SETTINGS),sendingEnabled:true};
  s.caps.activeStart=s.caps.activeEnd='00:00';s.caps.gapMinutes=5;
  await e.DB.prepare("INSERT INTO kv(key,value) VALUES ('settings',?)").bind(JSON.stringify(s)).run();
  const client=vi.spyOn(oauth,'upworkClient');
  expect(await runSender(e)).toBeNull();
  expect(client).not.toHaveBeenCalled();
  const state=JSON.parse(String(e.sqlite.prepare("SELECT value FROM kv WHERE key='state'").get()?.value));
  expect(state.senderNote).toContain('10 min');
});
