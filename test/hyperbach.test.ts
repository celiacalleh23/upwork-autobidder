import { afterEach, expect, it, vi } from 'vitest';
import { environment } from './support/db';
import { discoveryInput, mergeDiscoveryInput, receiveApify, drainApify, requestApifySync, syncApify, apifySyncStatus } from '../src/apify';
import { DEFAULT_SETTINGS, type Env } from '../src/settings';
const dbs:ReturnType<typeof environment>[]=[];
const env=()=>{const e=environment();dbs.push(e);return e;};
afterEach(()=>{vi.unstubAllGlobals();dbs.splice(0).forEach(e=>e.sqlite.close());});
it('maps OR phrases, countries, age and feed mode without restricting to unverified-only clients',()=>{
 const settings={...structuredClone(DEFAULT_SETTINGS),keywords:['Klaviyo','Email Marketer'],allowedCountries:['SWE','Canada'],verifiedOnly:false};
 const desired=discoveryInput(settings,'hyperbach');
 expect(desired).toEqual({keywords:'"Klaviyo" OR "Email Marketer"',keywords_match:'strict',title:'Klaviyo OR Email Marketer',client_location:'Sweden OR Canada',date_posted:'60m',notifications_only:true,estimate:false});
 expect(discoveryInput({...settings,verifiedOnly:true},'hyperbach')).toHaveProperty('buyer_payment_verified',true);
 const merged=mergeDiscoveryInput({query:'old',page:1,sort:'newest',maxJobAge:{},buyer_payment_verified:false,page_after:'old-cursor',clientId:'keep-feed',limit:25,fields:['id']},desired,'hyperbach');
 expect(merged).toMatchObject({...desired,clientId:'keep-feed',limit:25,fields:['id','url','title','date_posted']});
 for(const key of ['query','page','sort','maxJobAge','buyer_payment_verified','page_after'])expect(merged).not.toHaveProperty(key);
 expect(merged).not.toHaveProperty('price');expect(merged).not.toHaveProperty('price_min');
});
it('imports the documented Hyperbach URL and date_posted rather than its feed ingestion timestamp',async()=>{
 const e={...env(),APIFY_WEBHOOK_SECRET:'synthetic-webhook-secret-at-least-32-characters'};
 const item={id:'022053503680858460814',url:'https://www.upwork.com/jobs/~022053503680858460814',title:'Example',date_posted:'2026-05-10T15:53:24Z',created_at:'2026-05-10T15:59:01Z'};
 const r=await receiveApify(new Request('https://local.invalid/api/apify-webhook',{method:'POST',headers:{authorization:`Bearer ${e.APIFY_WEBHOOK_SECRET}`,'content-type':'application/json'},body:JSON.stringify({items:[item]})}),e,async()=>{});
 expect(r.status).toBe(202);await drainApify(e);
 expect(e.sqlite.prepare('SELECT id,posted_at FROM jobs').get()).toMatchObject({id:'2053503680858460814',posted_at:'2026-05-10T15:53:24.000Z'});
});
it('refuses an old queued Neatrat sync after switching provider without making a remote call',async()=>{
 const e={...env(),APIFY_TOKEN:'synthetic',APIFY_TASK_ID:'old-task'};
 await requestApifySync(e,structuredClone(DEFAULT_SETTINGS));
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await syncApify({...e,APIFY_PROVIDER:'hyperbach',APIFY_TASK_ID:'ayZDNeptTaU4NUy6M'});
 expect(fetch).not.toHaveBeenCalled();expect(await apifySyncStatus(e)).toMatchObject({status:'error'});
});
it('checks the task actor, applies the new schema and verifies removal of an old false payment flag',async()=>{
 const e={...env(),APIFY_TOKEN:'synthetic',APIFY_TASK_ID:'ayZDNeptTaU4NUy6M',APIFY_PROVIDER:'hyperbach' as const};
 const settings={...structuredClone(DEFAULT_SETTINGS),verifiedOnly:false};await requestApifySync(e,settings);
 let input:Record<string,unknown>={clientId:'keep-feed',buyer_payment_verified:false,rawUrl:'old',fields:['id']};
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
  if(!url.endsWith('/input'))return new Response(JSON.stringify({data:{actId:'RDMDCh3d2XZKng8Mz'}}));
  if(init.method==='PUT'){input=JSON.parse(String(init.body));return new Response(null,{status:204});}
  return new Response(JSON.stringify(input));
 });
 await syncApify(e);expect(await apifySyncStatus(e)).toMatchObject({provider:'hyperbach',status:'applied'});expect(input).not.toHaveProperty('buyer_payment_verified');expect(input).not.toHaveProperty('rawUrl');expect(input).toHaveProperty('date_posted','60m');
});
it('refuses to send Hyperbach input to a task owned by another actor',async()=>{
 const e={...env(),APIFY_TOKEN:'synthetic',APIFY_TASK_ID:'old-task',APIFY_PROVIDER:'hyperbach' as const};await requestApifySync(e,structuredClone(DEFAULT_SETTINGS));
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{actId:'other-actor'}})));vi.stubGlobal('fetch',fetch);
 await syncApify(e);expect(fetch).toHaveBeenCalledTimes(1);expect(await apifySyncStatus(e)).toMatchObject({status:'error',error:expect.stringContaining('No input was changed')});
});

it('removes the upstream title restriction when title-only is unchecked and avoids an AND title_search',()=>{
 const settings={...structuredClone(DEFAULT_SETTINGS),titleOnly:false};
 const managed=discoveryInput(settings,'hyperbach');expect(managed).not.toHaveProperty('title');
 const merged=mergeDiscoveryInput({title:'Klaviyo',title_search:['Klaviyo','Email Marketer']},managed,'hyperbach');
 expect(merged).not.toHaveProperty('title');expect(merged).not.toHaveProperty('title_search');
 expect(merged).toHaveProperty('keywords',managed.keywords);
});
