import { afterEach, expect, it, vi } from 'vitest';
import { handleApi } from '../src/api';
import { DEFAULT_SETTINGS } from '../src/settings';
import { environment } from './support/db';
const dbs:ReturnType<typeof environment>[]=[];
afterEach(()=>{vi.unstubAllGlobals();dbs.splice(0).forEach(e=>e.sqlite.close());});
it.each(['save','sync'])('acknowledges %s while Apify is slow, then confirms via the status endpoint',async(action)=>{
 const e={...environment(),APIFY_TOKEN:'synthetic',APIFY_TASK_ID:'task'};dbs.push(e);
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 let input:Record<string,unknown>={};
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{
  await gate;if(init.method==='PUT')input=JSON.parse(String(init.body));
  return new Response(JSON.stringify(input));
 });
 const work:Promise<unknown>[]=[];const ctx={waitUntil:(p:Promise<unknown>)=>{work.push(p);}};
 const path=action==='save'?'/api/settings':'/api/apify/sync';
 try {
  const response=await handleApi(new Request('https://local.invalid'+path,{method:action==='save'?'PUT':'POST',headers:{'x-dashboard':'1','content-type':'application/json'},body:JSON.stringify(action==='save'?DEFAULT_SETTINGS:{})}),e,path,ctx);
  expect(response.status).toBe(action==='save'?200:202);expect(work).toHaveLength(1);
  const pending=await handleApi(new Request('https://local.invalid/api/apify/status'),e,'/api/apify/status');expect(await pending.json()).toMatchObject({status:'pending'});
 } finally {release();await Promise.all(work);}
 const confirmed=await handleApi(new Request('https://local.invalid/api/apify/status'),e,'/api/apify/status');expect(await confirmed.json()).toMatchObject({status:'applied'});
});
it('persists a remote error after the browser request was acknowledged',async()=>{
 const e={...environment(),APIFY_TOKEN:'synthetic',APIFY_TASK_ID:'task'};dbs.push(e);
 vi.stubGlobal('fetch',async()=>new Response('Unavailable',{status:503}));
 const work:Promise<unknown>[]=[];
 await handleApi(new Request('https://local.invalid/api/apify/sync',{method:'POST',headers:{'x-dashboard':'1'}}),e,'/api/apify/sync',{waitUntil:p=>work.push(p)});
 await Promise.all(work);
 const r=await handleApi(new Request('https://local.invalid/api/apify/status'),e,'/api/apify/status');expect(await r.json()).toMatchObject({status:'error',error:'Apify request failed (503)'});
});
