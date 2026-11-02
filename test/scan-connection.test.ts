import { afterEach, expect, it, vi } from 'vitest';
import { environment } from './support/db';
import { getKv, putKv } from '../src/kv';
import { seal, unseal } from '../src/crypto';
import { finishUpworkAuth, getAccessToken, disconnectUpwork, scanConnection, checkUpwork } from '../src/oauth';
import { loadState, patchState } from '../src/settings';
import { McpClient } from '../src/mcp';
const dbs:ReturnType<typeof environment>[]=[];
const env=()=>{const e=environment();dbs.push(e);return e;};
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();dbs.splice(0).forEach(e=>e.sqlite.close());});
it('exchanges a scan-only login into separate encrypted storage and disconnects it independently', async()=>{
 const e=env(); await patchState(e,{upwork:{connected:true,account:'Bidding',orgUid:'primary',toolNames:{find_jobs:'find_jobs'}}});
 await putKv(e,'upwork_tokens','preserve-primary-token');
 await putKv(e,'upwork_client:scan',await seal(e,{clientId:'scan-client',redirectUri:'http://127.0.0.1:53682/upwork-callback',authMethod:'none'}));
 const state='synthetic-state-1234567890';await putKv(e,`oauth_state:${state}`,await seal(e,{purpose:'scan',verifier:'verifier',redirectUri:'http://127.0.0.1:53682/upwork-callback',exp:Date.now()+60000,as:{token_endpoint:'https://mock.invalid/token'}}));
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
  expect(url).toBe('https://mock.invalid/token');expect(String(init.body)).toContain('client_id=scan-client');
  return new Response(JSON.stringify({access_token:'scan-secret',refresh_token:'scan-refresh',expires_in:3600}));
 });
 await finishUpworkAuth(e,new URLSearchParams({state,code:'synthetic'}),'scan');
 expect(await getKv(e,'upwork_tokens')).toBe('preserve-primary-token');
 expect((await loadState(e)).upwork.orgUid).toBe('primary');
 expect(await getAccessToken(e,'scan')).toBe('scan-secret');
 expect((await unseal<{accessToken:string}>(e,(await getKv(e,'upwork_tokens:scan'))!)).accessToken).toBe('scan-secret');
 await disconnectUpwork(e,'scan');expect(await getKv(e,'upwork_tokens:scan')).toBeNull();expect(await getKv(e,'upwork_tokens')).toBe('preserve-primary-token');expect((await loadState(e)).upwork.connected).toBe(true);
});
it('rejects a callback for the wrong role before any token request',async()=>{
 const e=env(),state='synthetic-state-1234567890';await putKv(e,`oauth_state:${state}`,await seal(e,{purpose:'scan',exp:Date.now()+60000}));
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await expect(finishUpworkAuth(e,new URLSearchParams({state,code:'test'}),'bidding')).rejects.toThrow('different connection');expect(await getKv(e,`oauth_state:${state}`)).toBeTruthy();expect(fetch).not.toHaveBeenCalled();
});
it('blocks all spending and proposal tools on a scan-only client before dispatch',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 const client=new McpClient('https://mock.invalid','synthetic',25000,undefined,true);
 for(const name of ['manage_proposals','upwork__confirm_preview','list_freelancer_proposals','get_freelancer_dashboard'])await expect(client.callTool(name,{action:'create'})).rejects.toThrow('Scan-only');
 await expect(client.callTool('find_jobs',{action:'get'})).rejects.toThrow('Scan-only');expect(fetch).not.toHaveBeenCalled();
});
it('identifies the separate scanner without reading its balance or changing bidding state',async()=>{
 const e=env();await patchState(e,{upwork:{connected:true,account:'Bidding',orgUid:'primary',toolNames:{find_jobs:'find_jobs'}}});
 await putKv(e,'upwork_tokens:scan',await seal(e,{accessToken:'scanner',expiresAt:Date.now()+3600000}));
 const calls:string[]=[];
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{
  const m=JSON.parse(String(init.body));let result:unknown={};
  if(m.method==='initialize')result={protocolVersion:'2025-06-18'};
  if(m.method==='tools/list')result={tools:['list_accounts','find_jobs','manage_proposals','get_freelancer_dashboard'].map(name=>({name}))};
  if(m.method==='tools/call'){calls.push(m.params.name);result={structuredContent:{accounts:[{name:'Scanner',org_uid:'additional',role:'TALENT'}]}};}
  return new Response(m.id===undefined?null:JSON.stringify({id:m.id,jsonrpc:'2.0',result}),{status:m.id===undefined?202:200,headers:{'content-type':'application/json'}});
 });
 await checkUpwork(e,'scan');expect(calls).toEqual(['list_accounts']);expect((await loadState(e)).upwork.orgUid).toBe('primary');expect(await scanConnection(e)).toMatchObject({orgUid:'additional',toolNames:{find_jobs:'find_jobs',list_accounts:'list_accounts'}});expect((await scanConnection(e)).toolNames).not.toHaveProperty('manage_proposals');
});

it('counts prefixed search tools against the scanner budget only',async()=>{
 const e=env();vi.stubGlobal('fetch',async(_u:string,init:RequestInit)=>{const m=JSON.parse(String(init.body));return new Response(JSON.stringify({id:m.id,result:{structuredContent:{jobs:[]}}}),{headers:{'content-type':'application/json'}});});
 const c=new McpClient('https://mock.invalid','synthetic',25000,e,true);
 await c.callTool('upwork.find_jobs',{action:'search'});
 expect(e.sqlite.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'upwork:scanSearch:%'").get()?.n).toBe(1);
 expect(e.sqlite.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'upwork:search:%'").get()?.n).toBe(0);
});
