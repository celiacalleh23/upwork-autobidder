import { afterEach, expect, it, vi } from 'vitest';
import { environment } from './support/db';
import { drainDeliveries, enqueueJob, outboxSchema, receiveScanJob } from '../src/scanner/delivery';
import scanner from '../src/scanner/index';
import { runScan } from '../src/pipeline/scan';
import { patchState } from '../src/settings';
import { putKv } from '../src/kv';
import * as oauth from '../src/oauth';
const dbs: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); dbs.push(e); e.sqlite.exec(outboxSchema); return Object.assign(e, {
  SCAN_INTAKE_SECRET: 'r'.repeat(32), JOB_DELIVERY_SECRET: 'r'.repeat(32),
  SCANNER_ADMIN_SECRET: 'a'.repeat(32), JOB_DELIVERY_URL: 'https://receiver.invalid/api/jobs/scan-intake',
}); };
const id = '2115559352186121361';
const input = { jobUrl: id, title: 'Email job', postedAt: new Date().toISOString() };
const request = (secret = 'r'.repeat(32), body: unknown = input) => new Request('https://receiver.invalid/api/jobs/scan-intake', { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); dbs.splice(0).forEach(e => e.sqlite.close()); });
it('authenticates before touching storage and rejects oversized/invalid input', async () => {
  const e = env(); const init = vi.fn();
  expect((await receiveScanJob(request('wrong'), e, init)).status).toBe(401);
  expect((await receiveScanJob(request(undefined, { jobUrl: 'bad' }), e, init)).status).toBe(400);
  expect((await receiveScanJob(request(undefined, { jobUrl: id, title: 'x'.repeat(65000) }), e, init)).status).toBe(400);
  expect(init).not.toHaveBeenCalled();
});
it('preserves existing outcomes and deduplicates replay across sources', async () => {
  const e = env();
  expect((await receiveScanJob(request(), e, async () => {})).status).toBe(202);
  e.sqlite.prepare("UPDATE jobs SET status='filtered', reason='keep' WHERE id=?").run(id);
  const ack = await receiveScanJob(request(), e, async () => {});
  expect(await ack.json()).toEqual({ accepted: true, id });
  expect(e.sqlite.prepare('SELECT status,reason FROM jobs WHERE id=?').get(id)).toEqual({ status: 'filtered', reason: 'keep' });
  expect(e.sqlite.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'intake:accepted:%'").get()?.n).toBe(1);
});
it('does not acknowledge intake caps; durable delivery retries and survives a lost acknowledgement', async () => {
  vi.useFakeTimers(); const e = env(); const receiver = env();
  for (let i=0;i<30;i++) await putKv(receiver, `intake:accepted:${i}`, id);
  expect((await receiveScanJob(request(), receiver, async () => {})).status).toBe(429);
  receiver.sqlite.prepare("DELETE FROM kv WHERE key LIKE 'intake:accepted:%'").run();
  await enqueueJob(e, input); await enqueueJob(e, input);
  const fetcher = vi.fn().mockImplementationOnce(async (_url, options) => {
    await receiveScanJob(new Request('https://receiver.invalid/api/jobs/scan-intake', options), receiver, async () => {});
    throw new Error('ack lost');
  }).mockImplementation(async (_url, options) => receiveScanJob(new Request('https://receiver.invalid/api/jobs/scan-intake', options), receiver, async () => {}));
  vi.stubGlobal('fetch', fetcher);
  await drainDeliveries(e);
  expect(e.sqlite.prepare('SELECT attempts,delivered_at FROM scan_outbox').get()).toEqual({ attempts: 1, delivered_at: null });
  await drainDeliveries(e); expect(fetcher).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now()+60001); await drainDeliveries(e);
  expect(e.sqlite.prepare('SELECT delivered_at FROM scan_outbox').get()?.delivered_at).toBeTruthy();
  expect(receiver.sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()?.n).toBe(1);
  await enqueueJob(e,input); await drainDeliveries(e); expect(fetcher).toHaveBeenCalledTimes(2);
  expect(e.sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()?.n).toBe(0);
});
it('retains rejected acknowledgements and configuration failures for later repair', async () => {
  const e=env(); await enqueueJob(e,input);
  const fetcher=vi.fn().mockResolvedValue(Response.json({accepted:true,id:'wrong'})); vi.stubGlobal('fetch',fetcher);
  await drainDeliveries(e);
  expect(e.sqlite.prepare('SELECT delivered_at FROM scan_outbox').get()?.delivered_at).toBeNull();
  e.JOB_DELIVERY_URL='http://receiver.invalid/api/jobs/scan-intake';
  await expect(drainDeliveries(e)).rejects.toThrow('URL');
});
it('exposes only authenticated scanner administration, and never scans on retry cron', async () => {
  const e=env(); const client=vi.spyOn(oauth,'upworkClient');
  expect((await scanner.fetch(new Request('https://scanner.invalid/status'),e)).status).toBe(401);
  await scanner.scheduled({cron:'* * * * *',scheduledTime:Date.now()} as ScheduledController,e);
  expect(client).not.toHaveBeenCalled();
});
it('cutover flag disables legacy additional scans while leaving bidding configured', async () => {
  const e=Object.assign(env(),{EXTERNAL_SCAN_ONLY:'true'});
  await patchState(e,{paused:false});
  await putKv(e,'upwork:scanConnection',JSON.stringify({connected:true,orgUid:'scan',toolNames:{find_jobs:'find_jobs'}}));
  const client=vi.spyOn(oauth,'upworkClient');
  await runScan(e,Date.UTC(2026,10,2,12,15)); expect(client).not.toHaveBeenCalled();
});
it('scans exclusively through scan credentials into durable storage and suppresses duplicate cron slots', async () => {
  const e=env();
  await patchState(e,{paused:false});
  await putKv(e,'upwork:scanConnection',JSON.stringify({connected:true,orgUid:'separate',toolNames:{find_jobs:'find_jobs'}}));
  await putKv(e,'settings',JSON.stringify({keywords:['Email'],verifiedOnly:true}));
  const callTool=vi.fn().mockResolvedValue({jobs:[{id,title:'Email',published_date:new Date().toISOString()}]});
  const client=vi.spyOn(oauth,'upworkClient').mockResolvedValue({callTool} as never);
  const event={cron:'15,45 * * * *',scheduledTime:Date.UTC(2026,10,2,12,15)} as ScheduledController;
  await scanner.scheduled(event,e); await scanner.scheduled(event,e);
  expect(client).toHaveBeenCalledExactlyOnceWith(e,'scan');
  expect(callTool.mock.calls[0][1].org_uid).toBe('separate');
  expect(e.sqlite.prepare('SELECT COUNT(*) n FROM scan_outbox').get()?.n).toBe(1);
  expect(e.sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()?.n).toBe(0);
});
it('starts a fresh scanner paused and leaves unknown routes unavailable', async () => {
  const e=env();
  const headers={authorization:`Bearer ${e.SCANNER_ADMIN_SECRET}`};
  const status=await scanner.fetch(new Request('https://scanner.invalid/status',{headers}),e);
  expect((await status.json() as {paused:boolean}).paused).toBe(true);
  const response=await scanner.fetch(new Request('https://scanner.invalid/api/send',{method:'POST',headers,body:'{}'}),e);
  expect(response.status).toBe(404);
});
it('internally disables scan requests without deleting the saved connection', async () => {
  const e=Object.assign(env(),{SCAN_ACCOUNT_DISABLED:'true'});
  await patchState(e,{paused:false});
  await putKv(e,'upwork:scanConnection',JSON.stringify({connected:true,orgUid:'saved',toolNames:{find_jobs:'find_jobs'}}));
  const client=vi.spyOn(oauth,'upworkClient');
  await scanner.scheduled({cron:'15,45 * * * *',scheduledTime:Date.UTC(2026,10,2,12,15)} as ScheduledController,e);
  expect(client).not.toHaveBeenCalled();
  expect((await oauth.scanConnection(e)).connected).toBe(true);
  await expect(oauth.getAccessToken(e,'scan')).rejects.toThrow('temporarily unavailable');
});
