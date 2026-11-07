import { afterEach, expect, it, vi } from 'vitest';
import { environment } from './support/db';
import { discoveryDue, discoveryJob, runScan } from '../src/pipeline/scan';
import { persistSnapshot, snapshotHoldReason } from '../src/pipeline/snapshot';
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
it('stores the description already on the search hit and does not read the job again', async () => {
  const e = env();
  const id = '2119044137876131663';
  const at = Date.UTC(2026, 10, 7, 15, 30);
  await patchState(e, { paused: false, upwork: { connected: true, orgUid: 'mock', toolNames: { find_jobs: 'find_jobs' } } });
  await saveSettings(e, { ...structuredClone(DEFAULT_SETTINGS), keywords: ['Email'] });
  const callTool = vi.fn().mockResolvedValue({ jobs: [{
    id, title: 'Email Marketing Campaign Manager', published_date: new Date(at).toISOString(),
    description_snippet: 'Run the weekly campaigns and report on them.',
    job_type: 'hourly', budget: '30.00–40.00/hr', proposals_tier: '5 to 10',
    client: { country: 'United States', verification_status: 'VERIFIED' },
  }] });
  vi.spyOn(oauth, 'upworkClient').mockResolvedValue({ callTool } as unknown as McpClient);
  expect(discoveryJob({ id, published_date: new Date(at).toISOString(), description_snippet: 'Snippet only.' }, at)?.description).toBe('Snippet only.');
  await runScan(e, at);
  expect(callTool).toHaveBeenCalledTimes(1);
  expect(callTool.mock.calls[0][1]).toMatchObject({ action: 'search' });
  const row = e.sqlite.prepare('SELECT source, normalized FROM job_snapshots WHERE job_id = ?').get(id) as { source: string; normalized: string };
  const snap = JSON.parse(row.normalized);
  expect(row.source).toBe('automatic');
  expect(snap.description).toBe('Run the weekly campaigns and report on them.');
  expect(snap.verification).toBe('VERIFIED');
  expect(snapshotHoldReason(snap, { ...structuredClone(DEFAULT_SETTINGS), keywords: ['Email'] })).toBeNull();
  const rich = 'A'.repeat(80);
  await persistSnapshot(e, { jobId: id, source: 'apify', partial: false, raw: { description: rich, title: 'Email Marketing Campaign Manager' }, provenance: { source: 'apify' } });
  await persistSnapshot(e, { jobId: id, source: 'automatic', partial: true, raw: { description: 'short snippet' }, provenance: { source: 'automatic' } });
  await runScan(e, at);
  expect(JSON.parse(String(e.sqlite.prepare('SELECT normalized FROM job_snapshots WHERE job_id = ?').get(id)?.normalized)).description).toBe(rich);
  e.sqlite.prepare("UPDATE jobs SET status = 'error', reason = 'Held: the saved snapshot has no job description.' WHERE id = ?").run(id);
  await runScan(e, at + 1800_000);
  expect(e.sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(id)?.status).toBe('error');
  expect(callTool.mock.calls.every((call) => call[1].action === 'search')).toBe(true);
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
it('records each Upwork run including empty results and failures, without duplicating cron replays', async () => {
  const e=env();
  await patchState(e,{paused:false,upwork:{connected:true,orgUid:'primary',toolNames:{find_jobs:'find_jobs'}}});
  await saveSettings(e,{...structuredClone(DEFAULT_SETTINGS),keywords:['Email']});
  const callTool=vi.fn().mockResolvedValueOnce({jobs:[]}).mockRejectedValueOnce(new Error('Upwork unavailable'));
  vi.spyOn(oauth,'upworkClient').mockResolvedValue({callTool} as unknown as McpClient);
  const start=Date.UTC(2026,10,2,12,0);
  await runScan(e,start); await runScan(e,start);
  await expect(runScan(e,start+1800000)).rejects.toThrow('Upwork unavailable');
  const {discoveryRunHistory}=await import('../src/pipeline/scan');
  const history=await discoveryRunHistory(e);
  expect(history).toHaveLength(2);
  expect(history).toEqual(expect.arrayContaining([
    expect.objectContaining({source:'Upwork',purpose:'bidding',imported:0,error:null}),
    expect.objectContaining({source:'Upwork',purpose:'bidding',error:'Upwork unavailable'}),
  ]));
  expect(history.every(r => Number.isFinite(Date.parse(r.at)))).toBe(true);
  expect(callTool).toHaveBeenCalledTimes(2);
});
