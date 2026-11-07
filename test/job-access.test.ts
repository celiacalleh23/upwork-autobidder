import { afterEach, expect, it, vi } from 'vitest';
import { environment } from './support/db';
import { McpClient, McpJobAccessError, McpToolError } from '../src/mcp';
import { getKv, putKv } from '../src/kv';
import { JOB_READ_COOLDOWN_MS } from '../src/upworkPace';
import { patchState, DEFAULT_SETTINGS } from '../src/settings';
import { runWriter } from '../src/pipeline/write';
import * as oauth from '../src/oauth';
const dbs: ReturnType<typeof environment>[]=[];
const env=()=>{const e=environment();dbs.push(e);return e;};
const reason="This job can't be opened right now. It may be private or invite-only, or jobs are being opened too quickly. Slow down and try again later, and don't retry the same job repeatedly.";
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();dbs.splice(0).forEach(e=>e.sqlite.close());});
it('records the exact account/job trace, avoids immediate retries, and cools job reads without blocking searches',async()=>{
  vi.useFakeTimers(); const start=Date.now(); const e=env(); let refused=true;
  const fetcher=vi.fn(async(_url,init)=>{
    const m=JSON.parse(String(init.body));
    const result=refused ? {isError:true,content:[{type:'text',text:JSON.stringify({error_code:'PERMISSION',reason,trace_id:'test-trace'})}]} : {structuredContent:{jobs:[]}};
    return Response.json({jsonrpc:'2.0',id:m.id,result});
  });
  vi.stubGlobal('fetch',fetcher);
  const client=new McpClient(e.UPWORK_MCP_URL,'synthetic',25000,e);
  const args={action:'get',org_uid:'bidding-org',params:{id:'2115559352186121361'}};
  await expect(client.callTool('upwork__find_jobs',args)).rejects.toBeInstanceOf(McpJobAccessError);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await getKv(e,'upwork:jobAccess:last'))!)).toMatchObject({jobId:args.params.id,orgUid:'bidding-org',reason,traceId:'test-trace'});
  expect(Number(await getKv(e,'upwork:jobReadRetryAt'))).toBe(start+JOB_READ_COOLDOWN_MS);
  await expect(new McpClient(e.UPWORK_MCP_URL,'synthetic',25000,e).callTool('find_jobs',args)).rejects.toThrow('cooling down');
  expect(fetcher).toHaveBeenCalledTimes(1);
  refused=false;vi.setSystemTime(start+10001);
  await expect(client.callTool('find_jobs',{action:'search',org_uid:'bidding-org',params:{title:'Email'}})).resolves.toEqual({jobs:[]});
  expect(fetcher).toHaveBeenCalledTimes(2);
  vi.setSystemTime(start+JOB_READ_COOLDOWN_MS+1);
  await expect(client.callTool('find_jobs',{...args,params:{id:'2115559352186121362'}})).resolves.toEqual({jobs:[]});
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('does not classify a plain private-job refusal as a cooldown instruction',async()=>{
  const e=env();vi.stubGlobal('fetch',async(_url,init)=>{
    const m=JSON.parse(String(init.body));
    return Response.json({jsonrpc:'2.0',id:m.id,result:{isError:true,content:[{type:'text',text:JSON.stringify({error_code:'PERMISSION',reason:'Private job; invitation required.'})}]}});
  });
  await expect(new McpClient(e.UPWORK_MCP_URL,'synthetic',25000,e).callTool('find_jobs',{action:'get'})).rejects.toBeInstanceOf(McpToolError);
  expect(await getKv(e,'upwork:jobReadRetryAt')).toBeNull();
});
it('sets aside the refused job, stops the batch, and leaves later jobs waiting instead of retrying the same job',async()=>{
  const e={...env(),ANTHROPIC_API_KEY:'synthetic'};
  await patchState(e,{paused:false,upwork:{connected:true,orgUid:'bidding-org',toolNames:{find_jobs:'find_jobs',list_freelancer_proposals:'list_freelancer_proposals'}}});
  await putKv(e,'settings',JSON.stringify({...structuredClone(DEFAULT_SETTINGS),maxNewJobsPerRun:2,letter:{template:'Fixed letter',opening:'off',rules:''}}));
  e.sqlite.exec("INSERT INTO jobs(id,title,status,posted_at) VALUES ('2115559352186121361','First','matched','2026-11-07 12:01:00'),('2115559352186121362','Second','matched','2026-11-07 12:00:00')");
  const callTool=vi.fn().mockResolvedValueOnce({invitations:[]}).mockRejectedValue(new McpJobAccessError(reason,{jobId:'2115559352186121361',orgUid:'bidding-org',reason,traceId:'trace'}));
  vi.spyOn(oauth,'upworkClient').mockResolvedValue({callTool} as unknown as McpClient);
  await runWriter(e);
  expect(callTool).toHaveBeenCalledTimes(2);
  expect(e.sqlite.prepare('SELECT status,reason FROM jobs WHERE id=?').get('2115559352186121361')).toMatchObject({status:'error',reason:expect.stringContaining('will not be retried automatically')});
  expect(e.sqlite.prepare('SELECT status FROM jobs WHERE id=?').get('2115559352186121362')).toMatchObject({status:'matched'});
});

it('makes no Upwork writer requests while a persisted job-read cooldown is active', async () => {
  const e={...env(),ANTHROPIC_API_KEY:'synthetic'};
  await patchState(e,{paused:false,upwork:{connected:true,orgUid:'org',toolNames:{find_jobs:'find_jobs'}}});
  e.sqlite.exec("INSERT INTO jobs(id,title,status) VALUES ('2115559352186121361','Waiting job','matched')");
  await putKv(e,'upwork:jobReadRetryAt',String(Date.now()+JOB_READ_COOLDOWN_MS));
  const client=vi.spyOn(oauth,'upworkClient');
  expect((await runWriter(e))?.note).toContain('cooling down');
  expect(client).not.toHaveBeenCalled();
  expect(e.sqlite.prepare('SELECT status FROM jobs').get()?.status).toBe('matched');
});
