import { afterEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMetadataStore } from '../../apps/api/src/sqlite-store.ts';
import { ImmutableInputStore } from '../../apps/api/src/inputs.ts';
import { createApi } from '../../apps/api/src/server.ts';
import { sha256, specificationHashes, type JobSpec } from '../../packages/shared/src/index.ts';
import { fetchInput } from '../../packages/agent-runtime/src/input.ts';
import { runServicePass, watchService, type ServiceOptions } from '../../packages/agent-runtime/src/service.ts';
import type { RuntimeClient, RuntimeJob } from '../../packages/agent-runtime/src/pipeline.ts';
import { registerHostedProfile } from '../../packages/agent-runtime/src/registration.ts';

describe('persistent hosted runtime boundaries', () => {
  const cleanups:(()=>Promise<void>)[]=[];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
  async function fixture() {
    const root=await mkdtemp(join(tmpdir(),'agentbond-hosted-')), path=join(root,'state.sqlite');
    let store=new SqliteMetadataStore(path); await store.load();
    cleanups.push(async () => { store.close(); await rm(root,{recursive:true,force:true}); });
    const inputs=new ImmutableInputStore(store,join(root,'inputs'),'https://agentbond.example/api');
    const wallet=Keypair.generate(); const csv=Buffer.from('revenue\n1\n200\n');
    const record=await inputs.put(csv,wallet.publicKey.toBase58());
    const spec:JobSpec={type:'csv-analysis',input:{url:inputs.url(record.hash),hash:record.hash},acceptance:{numericColumns:['revenue'],anomaly:{column:'revenue',threshold:100,direction:'above'}}};
    return {root,path,store,inputs,wallet,csv,spec,restart:async () => {store.close();store=new SqliteMetadataStore(path);await store.load();return store;}};
  }
  it('persists immutable inputs, creator metadata, signed profiles, heartbeats and quotas across restart',async () => {
    const env=await fixture(),address=Keypair.generate().publicKey.toBase58();
    await env.store.putJob({address,title:'Persistent job',spec:env.spec});
    await env.store.putAgent({id:'csv-worker',wallet:env.wallet.publicKey.toBase58(),capabilities:['csv'],taskTypes:['csv-analysis'],maxRuntimeMs:2000});
    env.store.heartbeat({service:'worker',time:10,healthy:true,detail:'idle'});
    expect(env.store.reserveFaucet(env.wallet.publicKey.toBase58(),{identity:'unit-test'})).toBe(true);
    const store=await env.restart(); const inputs=new ImmutableInputStore(store,join(env.root,'inputs'),'https://agentbond.example/api');
    expect(store.job(address)?.spec).toEqual(env.spec); expect(store.agents()[0].wallet).toBe(env.wallet.publicKey.toBase58());
    expect(store.heartbeats()[0].time).toBe(10); expect(store.reserveFaucet(env.wallet.publicKey.toBase58(),{})).toBe(false);
    expect(await inputs.get(env.spec.input.hash)).toEqual(env.csv);
  });
  it('keeps conflicting profile ownership atomic across independent SQLite connections',async () => {
    const env=await fixture(),other=new SqliteMetadataStore(env.path);await other.load();
    try {
      const profile={id:'same-id',wallet:env.wallet.publicKey.toBase58(),capabilities:['csv'],taskTypes:['csv-analysis'] as ['csv-analysis'],maxRuntimeMs:2000};
      const results=await Promise.allSettled([env.store.putAgent(profile),other.putAgent({...profile,wallet:Keypair.generate().publicKey.toBase58()})]);
      expect(results.map(v=>v.status)).toEqual(['fulfilled','rejected']); expect(other.agents()).toEqual([profile]);
    } finally {other.close();}
  });
  it('rejects URL spelling variants, foreign URLs, modified files and wrong hash without DNS/network fallback',async () => {
    const env=await fixture(), policy={allowedOrigins:[],ownedResolver:(url:string,hash:string)=>env.inputs.resolveOwned(url,hash)};
    expect(await fetchInput(env.spec.input.url,env.spec.input.hash,policy)).toEqual(env.csv);
    for (const url of [env.spec.input.url+'?x=1',env.spec.input.url.replace('/inputs/','/inputs/../inputs/'),'http://169.254.169.254/latest','https://attacker.example/'+env.spec.input.hash]) await expect(fetchInput(url,env.spec.input.hash,policy)).rejects.toThrow('exact owned');
    await writeFile(join(env.root,'inputs',env.spec.input.hash+'.csv'),'revenue\n999\n');
    await expect(fetchInput(env.spec.input.url,env.spec.input.hash,policy)).rejects.toThrow('integrity');
  });
  it('enforces a bounded per-wallet upload quota and rejects oversized/invalid UTF8 input',async () => {
    const env=await fixture();
    await expect(env.inputs.put(Buffer.from([0xff,10]),env.wallet.publicKey.toBase58())).rejects.toThrow();
    await expect(env.inputs.put(Buffer.alloc(1024*1024+1),env.wallet.publicKey.toBase58())).rejects.toThrow('byte limit');
    for(let i=0;i<19;i++) await env.inputs.put(Buffer.from(`revenue\n${i+500}\n`),env.wallet.publicKey.toBase58());
    await expect(env.inputs.put(Buffer.from('revenue\n9000\n'),env.wallet.publicKey.toBase58())).rejects.toThrow('quota');
    expect(await env.inputs.put(env.csv,env.wallet.publicKey.toBase58())).toMatchObject({hash:env.spec.input.hash});
  });
  it('rejects a second API lease holder, permits expiry recovery and preserves lifetime faucet capacity',async () => {
    const env=await fixture(); expect(env.store.acquireLease('api','first',0,15)).toBe(true);expect(env.store.acquireLease('api','second',14,15)).toBe(false);expect(env.store.acquireLease('api','second',15,15)).toBe(true);
    env.store.releaseLease('api','first');expect(env.store.acquireLease('api','third',16,15)).toBe(false);
    expect(env.store.reserveFaucet('first',{},1)).toBe(true);expect(()=>env.store.reserveFaucet('second',{},1)).toThrow('capacity');
  });
  async function apiFixture() {
    const env=await fixture();const config={programId:'',mint:'unit-mint',network:'unit-test',rpcUrl:'',defaultVerifier:'unit-verifier',workerAddress:env.wallet.publicKey.toBase58(),metadataWrites:true,writesEnabled:true,inputUpload:true,faucetEnabled:true};
    const jobs:any[]=[];
    const funded:string[]=[];
    const api=createApi({config,store:env.store,inputStore:env.inputs,artifactRoot:env.root,authDomain:'agentbond.example',heartbeats:()=>env.store.heartbeats(),faucet:{request:async wallet=>{funded.push(wallet);return {solSignature:'unit-only-signature'};}},reader:{listJobs:async()=>jobs,getJob:async address=>jobs.find(v=>v.address===address)??null,events:async()=>[]}});
    await new Promise<void>(resolve=>api.server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(api.server.address() as {port:number}).port}`;
    cleanups.unshift(async()=>{await new Promise<void>(resolve=>api.server.close(()=>resolve()));});
    async function signed(action:string,raw:string|Buffer,route:string,type='text/csv') {
      const challenge=await(await fetch(origin+'/auth/challenge',{method:'POST',body:JSON.stringify({wallet:env.wallet.publicKey.toBase58(),action,bodyHash:sha256(raw)})})).json() as {nonce:string;message:string};
      const signature=Buffer.from(nacl.sign.detached(Buffer.from(challenge.message),env.wallet.secretKey)).toString('base64');
      const header='AgentBond '+Buffer.from(JSON.stringify({wallet:env.wallet.publicKey.toBase58(),nonce:challenge.nonce,signature})).toString('base64');
      const send=(data:string|Buffer=raw)=>fetch(origin+route,{method:'POST',headers:{Authorization:header,'Content-Type':type},body:typeof data==='string'?data:new Uint8Array(data)});return {send};
    }
    return {...env,api,origin,config,jobs,signed,funded};
  }
  it('authenticates exact raw upload bytes, rejects replay/substitution and serves immutable CSV',async () => {
    const env=await apiFixture(),csv=Buffer.from('revenue\r\n42\r\n');const request=await env.signed('upload-input',csv,'/inputs','text/csv; charset=utf-8');
    expect((await request.send(Buffer.from('revenue\n42\n'))).status).toBe(401);
    const response=await request.send();expect(response.status).toBe(201);
    const result=await response.json() as {input:{url:string;hash:string;bytes:number}};expect(result.input).toEqual({url:env.inputs.url(sha256(csv)),hash:sha256(csv),bytes:csv.length});
    expect((await request.send()).status).toBe(401); const download=await fetch(env.origin+'/inputs/'+sha256(csv)+'.csv');expect(Buffer.from(await download.arrayBuffer())).toEqual(csv);
    expect((await fetch(env.origin+'/inputs/'+'0'.repeat(64)+'.csv')).status).toBe(404);
  });
  it('enforces actual write flags, supported identities and exact owned URL metadata',async () => {
    const env=await apiFixture(),address=Keypair.generate().publicKey.toBase58();
    env.jobs.push({address,creator:env.wallet.publicKey.toBase58(),mint:'wrong-mint',verifier:'unit-verifier',...specificationHashes(env.spec)});
    let request=await env.signed('job-metadata',JSON.stringify({address,spec:env.spec}),'/jobs','application/json');expect((await request.send()).status).toBe(409);
    env.jobs[0].mint='unit-mint';const foreign={...env.spec,input:{...env.spec.input,url:'https://foreign.example/data.csv'}};Object.assign(env.jobs[0],specificationHashes(foreign));
    request=await env.signed('job-metadata',JSON.stringify({address,spec:foreign}),'/jobs','application/json');expect((await request.send()).status).toBe(400);
    env.config.writesEnabled=false;request=await env.signed('upload-input',env.csv,'/inputs');expect((await request.send()).status).toBe(503);
  });
  it('registers actual hosted keys through wallet challenges and rejects external registration endpoints',async () => {
    const env=await apiFixture();await registerHostedProfile(env.origin,'agentbond.example','worker',env.wallet);expect(env.store.agents()[0]).toMatchObject({id:'csv-worker',wallet:env.wallet.publicKey.toBase58()});
    await expect(registerHostedProfile('https://attacker.example','agentbond.example','worker',env.wallet)).rejects.toThrow('literal loopback');
  });
  it('rejects reserved service-ID impersonation and permits the configured role signer',async()=>{
    const env=await apiFixture(),profile={id:'independent-verifier',wallet:env.wallet.publicKey.toBase58(),capabilities:['csv'],taskTypes:['csv-analysis'],maxRuntimeMs:2000};
    let request=await env.signed('register-agent',JSON.stringify(profile),'/agents/register','application/json');expect((await request.send()).status).toBe(403);
    env.config.defaultVerifier=env.wallet.publicKey.toBase58();request=await env.signed('register-agent',JSON.stringify(profile),'/agents/register','application/json');expect((await request.send()).status).toBe(201);
    env.config.workerAddress=Keypair.generate().publicKey.toBase58();request=await env.signed('register-agent',JSON.stringify({...profile,id:'csv-worker'}),'/agents/register','application/json');expect((await request.send()).status).toBe(403);
  });
  it('binds faucet recipient to the signed wallet/body and consumes authorization once',async()=>{
    const env=await apiFixture();const wallet=env.wallet.publicKey.toBase58();
    let request=await env.signed('request-faucet',JSON.stringify({wallet:Keypair.generate().publicKey.toBase58()}),'/faucet','application/json');expect((await request.send()).status).toBe(403);expect(env.funded).toEqual([]);
    request=await env.signed('request-faucet',JSON.stringify({wallet}),'/faucet','application/json');expect((await request.send()).status).toBe(200);expect((await request.send()).status).toBe(401);expect(env.funded).toEqual([wallet]);
    env.config.faucetEnabled=false;request=await env.signed('request-faucet',JSON.stringify({wallet}),'/faucet','application/json');expect((await request.send()).status).toBe(503);expect(env.funded).toEqual([wallet]);
  });
  async function serviceFixture() {
    const env=await fixture(),worker=Keypair.generate().publicKey.toBase58(),verifier=Keypair.generate().publicKey.toBase58(),mint=Keypair.generate().publicKey.toBase58();
    const job:RuntimeJob={address:Keypair.generate().publicKey.toBase58(),status:'FUNDED',worker:null,verifier,mint,artifactHash:'0'.repeat(64),verificationHash:'0'.repeat(64),claimDeadline:Math.floor(Date.now()/1000)+500,...specificationHashes(env.spec)};
    await env.store.putJob({address:job.address,spec:env.spec});let settlements=0,approvals=0,lost=false;
    const client:RuntimeClient={listJobs:async()=>[{...job}],getJob:async()=>({...job}),claimJob:async()=>{job.status='CLAIMED';job.worker=worker;return 'unit-claim';},submitWork:async(_a,hash)=>{job.status='SUBMITTED';job.artifactHash=hash;return 'unit-submit';},approveWork:async(_a,hash)=>{approvals++;if(lost)throw Error('RPC lost before chain observation');job.status='VERIFIED';job.verificationHash=hash;return 'unit-approve';},rejectWork:async(_a,hash)=>{job.status='REJECTED';job.verificationHash=hash;return 'unit-reject';}};
    const options:ServiceOptions={role:'worker',wallet:worker,verifier,mint,client,outputDir:env.root,inputPolicy:{allowedOrigins:[],ownedResolver:(url,hash)=>env.inputs.resolveOwned(url,hash)},getSpec:async address=>env.store.job(address)?.spec??null,settle:async fresh=>{expect(fresh.worker).toBe(worker);settlements++;job.status='SETTLED';},heartbeat:value=>env.store.heartbeat(value)};
    return {...env,job,client,options,worker,verifier,mint,settlements:()=>settlements,approvals:()=>approvals,lose:(value:boolean)=>{lost=value;}};
  }
  it('continues from CLAIMED after restart and automatically verifies and settles to actual worker',async () => {
    const env=await serviceFixture();env.job.status='CLAIMED';env.job.worker=env.worker;
    expect((await runServicePass(env.options))[0].action).toBe('submitted');
    const verifier={...env.options,role:'verifier' as const,wallet:env.verifier};const result=await runServicePass(verifier);expect(result.map(v=>v.action)).toEqual(['approved','settled']);expect(env.job.status).toBe('SETTLED');expect(env.settlements()).toBe(1);
    expect(await runServicePass(verifier)).toEqual([]);expect(env.approvals()).toBe(1);
  });
  it('preserves exact receipts across failed approvals and independently rejects corrupted committed output',async () => {
    const env=await serviceFixture();await runServicePass(env.options);const verifier={...env.options,role:'verifier' as const,wallet:env.verifier};env.lose(true);
    expect((await runServicePass(verifier))[0].action).toBe('retry');const path=join(env.root,env.job.address+'.receipt.json'),original=await readFile(path);
    env.lose(false);expect((await runServicePass(verifier))[0].action).toBe('approved');expect(await readFile(path)).toEqual(original);
    env.job.status='SUBMITTED';const artifactPath=join(env.root,env.job.address+'.artifact.json'),artifact=JSON.parse(await readFile(artifactPath,'utf8'));artifact.rowCount=1;const bytes=JSON.stringify(artifact);env.job.artifactHash=sha256(bytes);await writeFile(artifactPath,bytes);await rm(path);
    expect((await runServicePass(verifier))[0].action).toBe('rejected');expect(env.job.status).toBe('REJECTED');expect(env.settlements()).toBe(1);
  });
  it('backs off bounded RPC failures, returns healthy after recovery and stops cleanly',async () => {
    const env=await serviceFixture();let reads=0;env.client.listJobs=async()=>{if(++reads<3)throw Error('RPC unavailable');return [];};const delays:number[]=[];
    await watchService(env.options,{maxPasses:3,intervalMs:1000,sleep:async ms=>{delays.push(ms);}});expect(delays).toEqual([2000,4000]);expect(env.store.heartbeats()[0]).toMatchObject({healthy:true});
    const abort=new AbortController();abort.abort();await watchService(env.options,{signal:abort.signal});expect(reads).toBe(3);
  });
  it('skips unsupported identities and prevents unfunded accounts from starving eligible work',async () => {
    const env=await serviceFixture();env.client.listJobs=async()=>[...Array.from({length:1200},()=>({...env.job,status:'CREATED'})),{...env.job,mint:'unsupported'},env.job];
    expect((await runServicePass(env.options)).map(v=>v.action)).toEqual(['submitted']);
  });
  it('rotates bounded active batches so a later eligible job receives processing',async () => {
    const env=await serviceFixture();const jobs=Array.from({length:101},()=>({...env.job,address:Keypair.generate().publicKey.toBase58()}));const seen=new Set<string>();env.client.listJobs=async()=>jobs;env.options.getSpec=async address=>{seen.add(address);return null;};
    await runServicePass(env.options);expect(seen.size).toBe(100);await runServicePass(env.options);expect(seen.size).toBe(101);
  });
});
