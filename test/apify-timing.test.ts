import {afterEach,expect,it,vi} from 'vitest';
import {environment} from './support/db';
import {apifyRunTiming,apifyRunHistory,receiveApify,drainApify} from '../src/apify';
import {putKv} from '../src/kv';
const dbs:ReturnType<typeof environment>[]=[];
afterEach(()=>{vi.unstubAllGlobals();dbs.splice(0).forEach(e=>e.sqlite.close());});
it('records actual flat/enveloped actor times without inventing missing times or treating job IDs as run IDs',()=>{
 const run={id:'run1',defaultDatasetId:'dataset1',startedAt:'2026-11-02T03:17:00Z',finishedAt:'2026-11-02T03:17:03Z'};
 expect(apifyRunTiming(run)).toMatchObject({runId:'run1',startedAt:'2026-11-02T03:17:00.000Z',finishedAt:'2026-11-02T03:17:03.000Z'});
 expect(apifyRunTiming({resource:run})).toMatchObject({runId:'run1',startedAt:'2026-11-02T03:17:00.000Z',finishedAt:'2026-11-02T03:17:03.000Z'});
 expect(apifyRunTiming({id:'job1',url:'https://www.upwork.com/jobs/~022053503680858460814',startedAt:'not-a-date'})).toMatchObject({runId:null,startedAt:null,finishedAt:null});
});
it('keeps one timing entry for retried notifications, including empty successful runs',async()=>{
 const e={...environment(),APIFY_TOKEN:'synthetic',APIFY_WEBHOOK_SECRET:'synthetic-secret-at-least-32-characters'};dbs.push(e);
 const body={resource:{id:'run1',defaultDatasetId:'dataset1',startedAt:'2026-11-02T03:17:00Z',finishedAt:'2026-11-02T03:17:03Z'}};
 const deliver=()=>receiveApify(new Request('https://local.invalid/api/apify-webhook',{method:'POST',headers:{authorization:`Bearer ${e.APIFY_WEBHOOK_SECRET}`},body:JSON.stringify(body)}),e,async()=>{});
 await deliver();await deliver();
 expect(await apifyRunHistory(e)).toHaveLength(1);
 vi.stubGlobal('fetch',async()=>new Response('[]'));await drainApify(e);
 const rows=await apifyRunHistory(e);expect(rows[0]).toMatchObject({runId:'run1',durationMs:3000,status:'done',imported:0,duplicates:0});expect(rows[0].receivedAt).toBeTruthy();expect(rows[0].importedAt).toBeTruthy();
 expect(rows[0]).not.toHaveProperty('items');expect(rows[0]).not.toHaveProperty('dataset');
});
it('handles old receipts without metadata and bounds the history to 20 entries',async()=>{
 const e=environment();dbs.push(e);
 for(let i=0;i<21;i++)await putKv(e,`apify:receipt:${i}`,JSON.stringify({status:'done',imported:1,duplicates:0,rejected:0}));
 const rows=await apifyRunHistory(e);expect(rows).toHaveLength(20);expect(rows[0]).toMatchObject({startedAt:null,finishedAt:null,receivedAt:null,durationMs:null});
});
