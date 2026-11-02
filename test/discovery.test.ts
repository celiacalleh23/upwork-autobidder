import { afterEach, expect, it, vi } from 'vitest';
import { environment } from './support/db';
import { discoveryDue, discoveryJob, runScan } from '../src/pipeline/scan';
import { permitSearch } from '../src/upworkPace';
import { getKv, putKv } from '../src/kv';
import { patchState, saveSettings, DEFAULT_SETTINGS } from '../src/settings';
import * as oauth from '../src/oauth';
import type { McpClient } from '../src/mcp';
const dbs: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); dbs.push(e); return e; };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); dbs.splice(0).forEach(e => e.sqlite.close()); });
it('schedules half-hour discovery and rejects old, future, missing-date and invalid jobs', () => {
  expect(Array.from({length:60},(_,i)=>i).filter(discoveryDue)).toEqual([0,15,30,45]);
  const now = Date.now(); const j = { id:'2115559352186121361', published_date:new Date(now-3599_000).toISOString() };
  expect(discoveryJob(j,now)?.automatic).toBe(true);
  expect(discoveryJob({...j,published_date:new Date(now-3600_001).toISOString()},now)).toBeNull();
  expect(discoveryJob({...j,published_date:new Date(now+301_000).toISOString()},now)).toBeNull();
  expect(discoveryJob({id:j.id},now)).toBeNull();
});
it.each([{limit:15,spacing:0,advance:60001},{limit:150,spacing:10000,advance:3600001},{limit:750,spacing:100000,advance:86400001}])('enforces rolling quota $limit with atomic shared reservations', async ({limit,spacing,advance}) => {
  vi.useFakeTimers(); const now = Date.now(); const e=env();
  for(let i=0;i<limit;i++) await putKv(e,`upwork:search:seed${i}`,String(now-i*spacing));
  await expect(permitSearch(e)).rejects.toThrow('quota');
  vi.setSystemTime(now+advance);
  await expect(permitSearch(e)).resolves.toBeUndefined();
});
it('deduplicates overlapping sources and repeated cron deliveries, and respects pause', async () => {
  const e=env(); await patchState(e,{paused:false,upwork:{connected:true,orgUid:'mock',toolNames:{find_jobs:'find_jobs'}}});
  await saveSettings(e,{...structuredClone(DEFAULT_SETTINGS),keywords:['Klaviyo','Email']});
  const callTool=vi.fn().mockResolvedValue({jobs:[{id:'2115559352186121361',title:'Klaviyo',published_date:new Date().toISOString()}]});
  vi.spyOn(oauth,'upworkClient').mockResolvedValue({callTool} as unknown as McpClient);
  const now=Date.UTC(2026,10,1,12,0); await runScan(e,now); await runScan(e,now);
  expect(callTool).toHaveBeenCalledTimes(2);
  expect(e.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n).toBe(1);
  expect(JSON.parse((await getKv(e,'discovery:lastScan'))!).imported).toBe(1);
  await patchState(e,{paused:true}); await runScan(e,now+1800_000);
  expect(callTool).toHaveBeenCalledTimes(2);
});

it('rotates accounts at quarter hours and keeps independent search budgets', async () => {
  const e=env(); await patchState(e,{paused:false,upwork:{connected:true,orgUid:'primary',toolNames:{find_jobs:'find_jobs'}}});
  await putKv(e,'upwork:scanConnection',JSON.stringify({connected:true,orgUid:'additional',toolNames:{find_jobs:'find_jobs'}}));
  await saveSettings(e,{...structuredClone(DEFAULT_SETTINGS),keywords:['Klaviyo']});
  const callTool=vi.fn().mockResolvedValue({jobs:[]});
  const client=vi.spyOn(oauth,'upworkClient').mockResolvedValue({callTool} as unknown as McpClient);
  const now=Date.UTC(2026,10,1,12,0);
  await runScan(e,now); expect(client).toHaveBeenLastCalledWith(e,'bidding'); expect(callTool.mock.calls[0][1].org_uid).toBe('primary');
  await runScan(e,now+15*60000);expect(client).toHaveBeenLastCalledWith(e,'scan');expect(callTool.mock.calls[1][1].org_uid).toBe('additional');
  await runScan(e,now+15*60000);expect(callTool).toHaveBeenCalledTimes(2);
  expect(await getKv(e,'discovery:lastScan:scan')).toBeTruthy();
  for(let i=0;i<15;i++)await putKv(e,`upwork:search:full${i}`,String(Date.now()));
  await expect(permitSearch(e)).rejects.toThrow('quota');await expect(permitSearch(e,true)).resolves.toBeUndefined();
});
