import { afterEach, describe, expect, it, vi } from 'vitest';
import { environment } from './support/db';
import worker from '../src/index';
import { handleApi, dayStartUtc } from '../src/api';
import { addJob } from '../src/pipeline/jobs';
import { acquireLease, getKv, putKv, releaseLease } from '../src/kv';
import { DEFAULT_SETTINGS, loadState, patchState, saveSettings, type Env } from '../src/settings';
import { runSender } from '../src/pipeline/send';
import { runWriter } from '../src/pipeline/write';
import { seal } from '../src/crypto';
import { drainApify, receiveApify, requestApifySync, syncApify, apifySyncStatus } from '../src/apify';
import { sendDailyReport } from '../src/pipeline/report';
import { cleanupLoomCopies } from '../src/loom';

const databases: ReturnType<typeof environment>[] = [];
const env = () => { const e = environment(); databases.push(e); return e; };
const request = (path: string, body: unknown, method = 'POST', headers: Record<string, string> = {}) => new Request('https://local.invalid'+path, { method, headers: { 'content-type': 'application/json', 'x-dashboard': '1', ...headers }, body: JSON.stringify(body) });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); databases.splice(0).forEach(e => e.sqlite.close()); });

async function connected(e: Env, auto = false) {
  await patchState(e, { mode: auto ? 'auto' : 'review', upwork: { connected: true, account: 'Synthetic', orgUid: 'mock', toolNames: {
    find_jobs: 'find_jobs', list_freelancer_proposals: 'list_freelancer_proposals', get_freelancer_dashboard: 'get_freelancer_dashboard', manage_proposals: 'manage_proposals', confirm_preview: 'confirm_preview',
  } } });
  await putKv(e, 'upwork_tokens', await seal(e, { accessToken: 'synthetic', expiresAt: Date.now()+3600_000 }));
}
async function sender(opts: { pause?: boolean; pauseDuringDispatch?: boolean; off?: boolean; cost?: number; warning?: boolean; questions?: string[]; answers?: unknown[]; response?: unknown; unknown?: boolean; autoApproval?: boolean } = {}) {
  vi.useFakeTimers();
  const e = env(); await connected(e);
  const settings = structuredClone(DEFAULT_SETTINGS); settings.sendingEnabled = true; settings.caps.activeStart = settings.caps.activeEnd = '00:00';
  settings.caps.connectsFloorEnabled = true; settings.caps.connectsFloor = 20; settings.caps.maxConnectsEnabled = true; settings.caps.maxConnectsPerJob = 16;
  await saveSettings(e, settings);
  e.sqlite.prepare("INSERT INTO proposals(job_id,title,cover_letter,bid,job_type,status,approved_via,create_params) VALUES ('2115559352186121361','Synthetic','Synthetic letter',40,'hourly','approved',?,?)")
    .run(opts.autoApproval ? 'auto-submit' : 'dashboard', JSON.stringify({ answers: opts.answers ?? [] }));
  if (opts.unknown) e.sqlite.exec("INSERT INTO proposals(job_id,title,cover_letter,status,submitted_at) VALUES ('2115559352186121362','Unclear','Letter','unknown',datetime('now','-2 days'))");
  let confirms = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(String(url)).toBe(e.UPWORK_MCP_URL);
    const m = JSON.parse(String(init.body)); let result: unknown = {};
    if (m.method === 'initialize') result = { protocolVersion: '2025-06-18' };
    if (m.method === 'tools/call') {
      const name = m.params.name; let data: unknown = {};
      if (name === 'get_freelancer_dashboard') data = { connectsBalance: 30 };
      if (name === 'find_jobs') data = { connects_cost: 8, connects_balance: 30, can_apply: true, applied: false };
      if (name === 'list_freelancer_proposals') data = m.params.arguments.action === 'invitations' ? { invitations: [] } : { proposals: [] };
      if (name === 'manage_proposals') {
        if (opts.pauseDuringDispatch) setTimeout(() => patchState(e, { paused: true, pausedReason: 'Paused from the dashboard' }), 5000);
        if (opts.pause) await patchState(e, { paused: true, pausedReason: 'Paused from the dashboard' });
        if (opts.off) await saveSettings(e, { ...settings, sendingEnabled: false });
        data = { preview_id: 'synthetic-preview', connects_cost: opts.cost ?? 8, can_apply: true, questions: opts.questions ?? [] };
      }
      if (name === 'confirm_preview') { confirms++; data = opts.response ?? { status: 'submitted', data: { createJobProposal: { status: 'SUCCESS', newProposalId: 'synthetic', error: null } } }; }
      result = name === 'get_freelancer_dashboard' && opts.warning ? { isError: true, content: [{ type: 'text', text: 'Your account is restricted due to violations of our Terms of Service' }] } : { structuredContent: data };
    }
    return new Response(m.id === undefined ? null : JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { status: m.id === undefined ? 202 : 200, headers: { 'content-type': 'application/json' } });
  });
  let done = false;
  const work = runSender(e).finally(() => { done = true; });
  for (let i = 0; i < 100 && !done; i++) await vi.advanceTimersByTimeAsync(10_000);
  await work;
  vi.useRealTimers();
  return { e, confirms, row: e.sqlite.prepare('SELECT status,connects FROM proposals WHERE id=1').get() };
}

describe('submission boundary (mocked upstream only)', () => {
  it('allows a valid, manually approved proposal and records its final cost', async () => {
    const r = await sender({ cost: 9 }); expect(r.confirms).toBe(1); expect(r.row).toMatchObject({ status: 'submitted', connects: 9 });
    expect(r.e.sqlite.prepare("SELECT count(*) n FROM kv WHERE key LIKE 'send:attempt:%'").get()?.n).toBe(1);
  });
  it.each([{ pause: true }, { off: true }])('does not confirm after controls change: %j', async opts => {
    const r = await sender(opts); expect(r.confirms).toBe(0); expect(r.row?.status).toBe('pending');
  });
  it('rechecks controls after waiting for the final request slot', async () => {
    const r = await sender({ pauseDuringDispatch: true }); expect(r.confirms).toBe(0); expect(r.row?.status).toBe('pending');
  });
  it('does not confirm a final price that violates either Connects limit', async () => {
    const r = await sender({ cost: 25 }); expect(r.confirms).toBe(0); expect(r.row?.status).toBe('pending');
  });
  it('stops and holds on an account warning', async () => {
    const r = await sender({ warning: true }); expect(r.confirms).toBe(0); expect((await loadState(r.e)).paused).toBe(true);
  });
  it('invalidates answers when question content changes without a count change', async () => {
    const r = await sender({ questions: ['New question'], answers: [{ question: 'Old question', answer: 'Old answer' }] });
    expect(r.confirms).toBe(0); expect(r.row?.status).toBe('pending');
  });
  it('keeps an unrecognized confirm response unknown', async () => {
    const r = await sender({ response: { processing: true } }); expect(r.confirms).toBe(1); expect(r.row?.status).toBe('unknown');
  });
  it('never resumes new spending merely because an unknown attempt is old', async () => {
    const r = await sender({ unknown: true }); expect(r.confirms).toBe(0);
    expect(r.e.sqlite.prepare('SELECT status FROM proposals WHERE id=2').get()?.status).toBe('unknown');
  });
  it('requires manual approval in Review even for an old Auto approval', async () => {
    const r = await sender({ autoApproval: true }); expect(r.confirms).toBe(0); expect(r.row?.status).toBe('pending');
  });
});

describe('atomic D1 controls and intake', () => {
  it('preserves concurrent pause, balance and nested connection changes', async () => {
    const e = env(); await Promise.all([patchState(e, { paused: true }), patchState(e, { connectsBalance: 123 }), patchState(e, { upwork: { lastError: 'read failed' } })]);
    expect(await loadState(e)).toMatchObject({ paused: true, connectsBalance: 123, upwork: { lastError: 'read failed' } });
  });
  it('a previous lease holder cannot release its successor', async () => {
    const e = env(); const old = await acquireLease(e, 'work', -1); const next = await acquireLease(e, 'work', 60_000);
    await releaseLease(e, 'work', old!); expect(await acquireLease(e, 'work', 60_000)).toBeNull();
    await releaseLease(e, 'work', next!); expect(await acquireLease(e, 'work', 60_000)).toBeTruthy();
  });
  it('automatic replay preserves a rejected outcome and first-seen time', async () => {
    const e = env(); await addJob(e, { jobUrl: '2115559352186121361' });
    e.sqlite.exec("UPDATE jobs SET status='low_score', reason='Score too low', seen_at='2020-01-01 00:00:00'");
    expect((await addJob(e, { jobUrl: '2115559352186121361', automatic: true })).ok).toBe(false);
    expect(e.sqlite.prepare('SELECT status,seen_at FROM jobs').get()).toMatchObject({ status: 'low_score', seen_at: '2020-01-01 00:00:00' });
    expect(await addJob(e, { jobUrl: '2115559352186121361' })).toMatchObject({ ok: true, status: 'requeued' });
  });
  it('processed jobs remain in the hourly limit', async () => {
    const e = env();
    for (let i=0; i<30; i++) { expect((await addJob(e,{ jobUrl: String(2115559352186121361n+BigInt(i)) })).ok).toBe(true); e.sqlite.exec("UPDATE jobs SET reason='Scored', status='low_score'"); }
    expect(await addJob(e,{ jobUrl: '2115559352186121499' })).toMatchObject({ ok: false, retryable: true });
  });
  it('Approve preserves the actual send time', async () => {
    const e = env(); const lastSendAt = new Date().toISOString(); await patchState(e, { lastSendAt });
    e.sqlite.exec("INSERT INTO proposals(job_id,title,cover_letter,status) VALUES ('test','Synthetic','Letter','pending')");
    expect((await handleApi(request('/api/proposals/1/approve', {}),e,'/api/proposals/1/approve')).status).toBe(200);
    expect((await loadState(e)).lastSendAt).toBe(lastSendAt);
  });
  it('Review returns only unsent Auto approvals to the queue', async () => {
    const e = env(); e.sqlite.exec("INSERT INTO proposals(job_id,title,cover_letter,status,approved_via) VALUES ('auto','Synthetic','Letter','approved','auto-submit'),('manual','Synthetic','Letter','approved','dashboard')");
    await handleApi(request('/api/mode',{ mode:'review' }),e,'/api/mode');
    expect(e.sqlite.prepare('SELECT job_id,status FROM proposals ORDER BY id').all()).toEqual([{job_id:'auto',status:'pending'},{job_id:'manual',status:'approved'}]);
  });
});

describe('durable Apify delivery and synchronization', () => {
  it('fails closed without a secret, and rejects incorrect authentication', async () => {
    const e=env(); expect((await worker.fetch(request('/api/apify-webhook',[]),e)).status).toBe(503);
    const configured = { ...e, APIFY_WEBHOOK_SECRET:'synthetic-secret-with-32-characters' };
    expect((await worker.fetch(request('/api/apify-webhook',[]),configured)).status).toBe(401);
  });
  it('checkpoints a dataset delivery, imports once and retains its receipt', async () => {
    const e={...env(),APIFY_WEBHOOK_SECRET:'synthetic-secret-with-32-characters',APIFY_TOKEN:'synthetic'};
    const body={eventType:'ACTOR.RUN.SUCCEEDED',resource:{id:'run1',defaultDatasetId:'dataset1'}};
    const send=()=>worker.fetch(request('/api/apify-webhook',body,'POST',{authorization:`Bearer ${e.APIFY_WEBHOOK_SECRET}`}),e);
    expect((await send()).status).toBe(202); expect((await (await send()).json()).duplicate).toBe(true);
    vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{ expect(url).toContain('/datasets/dataset1/items?offset=0&limit=20'); expect(url).not.toContain('token='); expect(init.headers).toMatchObject({authorization:'Bearer synthetic'}); return new Response(JSON.stringify([{url:'https://www.upwork.com/jobs/~022115559352186121361'}])); });
    await drainApify(e); await drainApify(e);
    expect(e.sqlite.prepare('SELECT count(*) n FROM jobs').get()?.n).toBe(1);
    expect(JSON.parse((await getKv(e,'apify:lastImport'))!)).toMatchObject({status:'done',imported:1,offset:1});
  });
  it('retains a failed dataset for retry without reporting import success', async () => {
    const e={...env(),APIFY_WEBHOOK_SECRET:'synthetic-secret-with-32-characters',APIFY_TOKEN:'synthetic'};
    await receiveApify(request('/api/apify-webhook',{defaultDatasetId:'dataset'},'POST',{authorization:`Bearer ${e.APIFY_WEBHOOK_SECRET}`}),e,async()=>{});
    vi.stubGlobal('fetch',async()=>new Response('Unavailable',{status:503})); await drainApify(e);
    expect(JSON.parse((await getKv(e,'apify:lastImport'))!)).toMatchObject({status:'error',offset:0});
  });
  it('keeps local settings and reports a failed external synchronization', async()=>{
    const e={...env(),APIFY_TOKEN:'synthetic',APIFY_TASK_ID:'task'};
    await requestApifySync(e,structuredClone(DEFAULT_SETTINGS)); vi.stubGlobal('fetch',async()=>new Response('Failed',{status:500}));
    await syncApify(e); expect(await apifySyncStatus(e)).toMatchObject({status:'error'});
  });
  it('preserves nonmanaged task input and verifies the applied revision',async()=>{
    const e={...env(),APIFY_TOKEN:'synthetic',APIFY_TASK_ID:'task'}; let input:Record<string,unknown>={proxyConfiguration:{useApifyProxy:true},customFlag:true,fixedPriceRange:[20,10000],hourlyRateRange:[0,1000],maxJobAge:{value:15,unit:'minutes'},jobType:['fixed','hourly']};
    await requestApifySync(e,structuredClone(DEFAULT_SETTINGS));
    vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{ expect(url).toBe('https://api.apify.com/v2/actor-tasks/task/input'); if(init.method==='PUT')input=JSON.parse(String(init.body)); return new Response(JSON.stringify(input)); });
    await syncApify(e); expect(input).toMatchObject({customFlag:true,proxyConfiguration:{useApifyProxy:true},fixedPriceRange:[150,10000],hourlyRateRange:[30,1000],maxJobAge:{value:60,unit:'minutes'},jobType:['fixed','hourly']}); expect(await apifySyncStatus(e)).toMatchObject({status:'applied'});
  });
});

describe('notifications and calendar boundaries',()=>{
  it('sends one daily report under concurrent cron execution',async()=>{
    const e={...env(),RESEND_API_KEY:'synthetic'};const s=structuredClone(DEFAULT_SETTINGS);s.report={email:'test@example.invalid',hour:0};await saveSettings(e,s);
    const f=vi.fn(async()=>new Response('{}'));vi.stubGlobal('fetch',f);
    await Promise.all([sendDailyReport(e),sendDailyReport(e)]);expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]?.[1]?.headers?.['Idempotency-Key']).toBeTruthy();
  });
  it('uses the midnight offset across both Los Angeles DST transitions',()=>{
    expect(dayStartUtc('America/Los_Angeles',new Date('2026-03-08T18:00:00Z'))).toBe('2026-03-08 08:00:00');
    expect(dayStartUtc('America/Los_Angeles',new Date('2026-11-01T18:00:00Z'))).toBe('2026-11-01 07:00:00');
  });
});

describe('writer policy through the real pipeline', () => {
  async function write({ title='Klaviyo catalog project', description='Build email flows.', verified='VERIFIED', count=5, warning=false } = {}) {
    vi.useFakeTimers(); const e={...env(), ANTHROPIC_API_KEY:'synthetic', ANTHROPIC_BASE_URL:'https://mock.invalid/anthropic'};
    await connected(e,true);const s=structuredClone(DEFAULT_SETTINGS);s.letter={template:'Hi there,\n\nThe fixed letter.',opening:'off',rules:''};await saveSettings(e,s);
    await addJob(e,{jobUrl:'2115559352186121361'});let aiCalls=0;
    vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
      expect(new URL(url).hostname).toBe('mock.invalid');
      if(String(url).includes('/anthropic')) { aiCalls++;return new Response(JSON.stringify({id:'synthetic',type:'message',role:'assistant',model:'mock',content:[{type:'text',text:JSON.stringify({profile_fit:90,win_similarity:0,reason:'Synthetic fit',pros:[],cons:[]})}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}),{headers:{'content-type':'application/json'}}); }
      const m=JSON.parse(String(init.body));let result:unknown={};
      if(m.method==='initialize')result={protocolVersion:'2025-06-18'};
      if(m.method==='tools/call'){
        let data:unknown={}; const name=m.params.name;
        if(name==='list_freelancer_proposals')data={invitations:[]};
        if(name==='find_jobs')data={connects_cost:8,connects_balance:100,can_apply:true,applied:false,verification_status:verified,proposal_count:count,published_date:'2026-10-31T18:00:00Z',marketplaceJobPosting:{content:{title,description},clientCompanyPublic:{country:{name:'United States'}},contractTerms:{contractType:'HOURLY',hourlyContractTerms:{hourlyBudgetMin:40,hourlyBudgetMax:50}}}};
        if(name==='manage_proposals')data={preview_id:'synthetic-preview',connects_cost:8,can_apply:true,questions:[]};
        result=name==='manage_proposals'&&warning?{isError:true,content:[{type:'text',text:'Your account is restricted due to violations of our Terms of Service'}]}:{structuredContent:data};
      }
      return new Response(m.id===undefined?null:JSON.stringify({jsonrpc:'2.0',id:m.id,result}),{status:m.id===undefined?202:200,headers:{'content-type':'application/json'}});
    });
    let done=false;const work=runWriter(e).finally(()=>{done=true;});for(let i=0;i<80&&!done;i++)await vi.advanceTimersByTimeAsync(10_000);await work;vi.useRealTimers();
    return {e,aiCalls};
  }
  it('preserves automatic drafting for a verified eligible job',async()=>{
    const {e,aiCalls}=await write();expect(aiCalls).toBe(1);
    expect(e.sqlite.prepare('SELECT status,approved_via FROM proposals').get()).toMatchObject({status:'approved',approved_via:'auto-submit'});
    expect(e.sqlite.prepare('SELECT posted_at FROM jobs').get()?.posted_at).toBe('2026-10-31T18:00:00.000Z');
  });
  it.each([{title:'Unrelated catalog project'},{description:'Requires WordPress work.'},{verified:'UNVERIFIED'},{count:100}])('rejects an ineligible job before Claude: %j',async opts=>{
    const {e,aiCalls}=await write(opts);expect(aiCalls).toBe(0);expect(e.sqlite.prepare('SELECT status FROM jobs').get()?.status).toBe('filtered');
    expect(e.sqlite.prepare('SELECT count(*) n FROM proposals').get()?.n).toBe(0);
  });
  it('does not auto-approve through a preview account warning',async()=>{
    const {e}=await write({warning:true});expect((await loadState(e)).paused).toBe(true);expect(e.sqlite.prepare('SELECT count(*) n FROM proposals').get()?.n).toBe(0);
  });
});

describe('dashboard review actions and request boundaries',()=>{
  it('Skip still works for both pending and approved proposals',async()=>{
    const e=env();e.sqlite.exec("INSERT INTO proposals(job_id,title,cover_letter,status) VALUES ('a','Synthetic','Letter','pending'),('b','Synthetic','Letter','approved')");
    for(const id of [1,2])expect((await handleApi(request(`/api/proposals/${id}/skip`,{}),e,`/api/proposals/${id}/skip`)).status).toBe(200);
    expect(e.sqlite.prepare("SELECT count(*) n FROM proposals WHERE status='skipped'").get()?.n).toBe(2);
  });
  it('edits screening answers and refuses blank answers on approval',async()=>{
    const e=env();e.sqlite.prepare("INSERT INTO proposals(job_id,title,cover_letter,status,create_params) VALUES ('a','Synthetic','Letter','pending',?)").run(JSON.stringify({answers:[{question:'Availability?',answer:''}]}));
    expect((await handleApi(request('/api/proposals/1/approve',{}),e,'/api/proposals/1/approve')).status).toBe(400);
    expect((await handleApi(request('/api/proposals/1',{cover_letter:'Updated letter',answers:[{question:'Availability?',answer:'Next week.'}]},'PATCH'),e,'/api/proposals/1')).status).toBe(200);
    expect((await handleApi(request('/api/proposals/1/approve',{}),e,'/api/proposals/1/approve')).status).toBe(200);
  });
  it('resolves uncertainty only with an explicit dashboard confirmation and never retries',async()=>{
    const e=env();e.sqlite.exec("INSERT INTO proposals(job_id,title,cover_letter,status) VALUES ('a','Synthetic','Letter','unknown')");
    const path='/api/proposals/1/resolve-unknown';
    expect((await handleApi(request(path,{outcome:'not_sent'}),e,path)).status).toBe(400);
    expect((await handleApi(request(path,{outcome:'not_sent',confirm:true}),e,path)).status).toBe(200);
    expect(e.sqlite.prepare('SELECT status FROM proposals').get()?.status).toBe('failed');
  });
  it('rejects an oversized webhook without relying on Content-Length',async()=>{
    const e={...env(),APIFY_WEBHOOK_SECRET:'synthetic-secret-with-32-characters'};
    const r=await worker.fetch(request('/api/apify-webhook',[{url:'x'.repeat(130000)}],'POST',{authorization:`Bearer ${e.APIFY_WEBHOOK_SECRET}`}),e);
    expect(r.status).toBe(400);expect(e.sqlite.prepare("SELECT count(*) n FROM kv WHERE key LIKE 'apify:receipt:%'").get()?.n).toBe(0);
  });
  it('rate limits parallel login attempts',async()=>{
    const e=env();const attempts=await Promise.all(Array.from({length:12},()=>worker.fetch(new Request('https://local.invalid/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'password=wrong'}),e)));
    expect(attempts.filter(r=>r.status===429)).toHaveLength(2);expect(attempts.filter(r=>r.status===401)).toHaveLength(10);
  });
});

describe('recoverable cleanup and report coverage',()=>{
  it('keeps unsuccessful Loom deletions retryable and protects active proposals',async()=>{
    const e=env();await patchState(e,{loom:{connected:true}});await putKv(e,'loom:session',await seal(e,{cookie:'synthetic',expiresAt:null}));
    e.sqlite.exec("INSERT INTO proposals(job_id,title,cover_letter,status,loom_video_id,created_at) VALUES ('sent','Synthetic','Letter','submitted','oldcopy',datetime('now','-40 days')),('waiting','Synthetic','Letter','pending','activecopy',datetime('now','-40 days'))");
    const deleted:string[]=[];vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{expect(url).toBe('https://www.loom.com/graphql');deleted.push(...JSON.parse(String(init.body)).variables.videoIds);return new Response(JSON.stringify({data:{bulkDeleteVideos:{success:false}}}),{headers:{'content-type':'application/json'}});});
    await cleanupLoomCopies(e,30);expect(deleted).toEqual(['oldcopy']);expect(e.sqlite.prepare('SELECT loom_deleted_at FROM proposals WHERE id=1').get()?.loom_deleted_at).toBeNull();
  });
  it('includes late previous-day activity in the next report',async()=>{
    const e={...env(),RESEND_API_KEY:'synthetic'};const s=structuredClone(DEFAULT_SETTINGS);s.caps.timezone='UTC';s.report={email:'test@example.invalid',hour:15};await saveSettings(e,s);
    const deliveries:string[]=[];vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{deliveries.push(JSON.parse(String(init.body)).text);return new Response('{}');});
    await sendDailyReport(e,{now:new Date('2026-10-30T15:00:00Z')});
    e.sqlite.exec("INSERT INTO proposals(job_id,title,cover_letter,status,submitted_at) VALUES ('late','Late previous-day proposal','Letter','submitted','2026-10-30 20:00:00')");
    await sendDailyReport(e,{now:new Date('2026-10-31T15:00:00Z')});expect(deliveries[1]).toContain('Late previous-day proposal');
  });
});

describe('delivery retries',()=>{
  it('retains identical email content when a changing balance is retried',async()=>{
    const {sendEmail}=await import('../src/email');const e={...env(),RESEND_API_KEY:'synthetic'};const bodies:string[]=[];
    vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{bodies.push(String(init.body));return new Response('{}');});
    await sendEmail(e,['test@example.invalid'],'Balance 10','Balance 10',undefined,'synthetic-stable-id');
    await sendEmail(e,['other@example.invalid'],'Balance 5','Balance 5',undefined,'synthetic-stable-id');
    expect(bodies[0]).toBe(bodies[1]);
  });
});


describe('Apify task limits from the production configuration screenshots', () => {
  it('refuses to silently widen an existing price ceiling', async () => {
    const { mergeDiscoveryInput } = await import('../src/apify');
    expect(() => mergeDiscoveryInput({ fixedPriceRange: [20, 10000] }, { fixedPriceRange: [20000] })).toThrow('exceeds');
  });
  it('does not invent a maximum budget when the task contract is missing', async () => {
    const { mergeDiscoveryInput } = await import('../src/apify');
    expect(() => mergeDiscoveryInput({}, { fixedPriceRange: [20] })).toThrow('ceiling will not be guessed');
    expect(mergeDiscoveryInput({ maxJobAge: { value: 15, unit: 'minutes' } }, { fixedPriceRange: [0] })).toEqual({ maxJobAge: { value: 15, unit: 'minutes' } });
  });
});
