import { describe,expect,it } from 'vitest';
import { Connection,Keypair,PublicKey } from '@solana/web3.js';
import { ChainIndex,type ChainJob } from '../../apps/api/src/indexer.ts';
import { createChainReader } from '../../apps/api/src/reader.ts';
import { AGENTBOND_IDL,PROGRAM_ID } from '../../packages/sdk/src/index.ts';
import { watchService,type ServiceOptions } from '../../packages/agent-runtime/src/service.ts';

const job:ChainJob={address:'unit-job',status:'CREATED',creator:'creator',worker:null,verifier:'verifier',amount:'25',specHash:'',acceptanceHash:'',artifactHash:'',verificationHash:''};
describe('bounded authoritative RPC reuse',()=>{
  it('coalesces concurrent snapshots and account reads, with fresh reads after their flight',async()=>{
    let lists=0,accounts=0;let resolveList!:(jobs:ChainJob[])=>void,resolveJob!:(job:ChainJob)=>void;
    const list=new Promise<ChainJob[]>(resolve=>resolveList=resolve),account=new Promise<ChainJob>(resolve=>resolveJob=resolve);
    const index=new ChainIndex({listJobs:async()=>{lists++;return list;},getJob:async()=>{accounts++;return account;},events:async()=>[]});
    const reads=Array.from({length:12},()=>index.reconcile());expect(lists).toBe(1);resolveList([job]);expect((await Promise.all(reads)).every(value=>value[0].status==='CREATED')).toBe(true);
    await index.reconcile();expect(lists).toBe(2);
    const details=Array.from({length:12},()=>index.get(job.address));expect(accounts).toBe(1);resolveJob(job);await Promise.all(details);await index.get(job.address);expect(accounts).toBe(2);
  });
  it('expires <=1s snapshot reuse, invalidates after metadata intake, and never serves stale data after failed refresh',async()=>{
    let now=100,reads=0,offline=false,state=job;
    const index=new ChainIndex({listJobs:async()=>{reads++;if(offline)throw Error('RPC429');return [state];},getJob:async()=>state,events:async()=>[]},{cacheMs:750,now:()=>now});
    await index.reconcile();now=849;await index.reconcile();expect(reads).toBe(1);
    now=850;offline=true;await expect(index.reconcile()).rejects.toThrow('RPC429');await expect(index.reconcile()).rejects.toThrow('RPC429');expect(reads).toBe(3);
    offline=false;state={...job,status:'FUNDED'};expect((await index.reconcile())[0].status).toBe('FUNDED');index.invalidateSnapshot();await index.reconcile();expect(reads).toBe(5);
    expect(()=>new ChainIndex(index.reader,{cacheMs:1001})).toThrow('1000ms');
  });
  it('resolves scan-lagging registered addresses from fresh accounts and refuses metadata-only or cached presence',async()=>{
    let exists=true,offline=false,accounts=0;
    const index=new ChainIndex({listJobs:async()=>{if(offline)throw Error('scan RPC failed');return [];},getJob:async()=>{accounts++;return exists?job:null;},events:async()=>[]},{knownAddresses:()=>[job.address]});
    expect(await index.reconcile()).toEqual([job]);expect(accounts).toBe(1);exists=false;expect(await index.reconcile()).toEqual([]);expect(accounts).toBe(2);
    offline=true;await expect(index.reconcile()).rejects.toThrow('scan RPC failed');expect(accounts).toBe(2);
  });
  it('invalidates subsecond snapshot reuse after any observed account or signature RPC failure',async()=>{
    let reads=0;const index=new ChainIndex({listJobs:async()=>{reads++;return[job];},getJob:async()=>{throw Error('account429');},events:async()=>{throw Error('signatures429');}},{cacheMs:750});
    await index.reconcile();await expect(index.get(job.address)).rejects.toThrow('account429');await index.reconcile();expect(reads).toBe(2);
    await expect(index.events(job.address)).rejects.toThrow('signatures429');await index.reconcile();expect(reads).toBe(3);
  });
  function readerFixture(limit=1024) {
    const address=Keypair.generate().publicKey.toBase58(),remaining=Keypair.generate().publicKey,worker=Keypair.generate().publicKey;let signatures=[{signature:'unit-1',slot:10,blockTime:100,err:null,confirmationStatus:'finalized'}];let calls=0,polls=0,missing=false,fail=false;
    const discriminator=AGENTBOND_IDL.instructions.find(value=>value.name==='claim_job')!.discriminator;
    const keys=[PROGRAM_ID,worker,new PublicKey(address),remaining];
    const tx={meta:{err:null,loadedAddresses:undefined},transaction:{message:{getAccountKeys:()=>({get:(index:number)=>keys[index]}),compiledInstructions:[{programIdIndex:0,accountKeyIndexes:[1,2,3],data:Uint8Array.from(discriminator)}]}}};
    const connection={getSignaturesForAddress:async()=>{polls++;if(fail)throw Error('signatures RPC failed');return signatures;},getTransaction:async()=>{calls++;return missing?null:tx;}} as unknown as Connection;
    const reader=createChainReader(connection,PROGRAM_ID,{finalizedCacheSize:limit});return{reader,address,remaining:remaining.toBase58(),calls:()=>calls,polls:()=>polls,set:(value:typeof signatures)=>{signatures=value;},missing:(value:boolean)=>{missing=value;},fail:(value:boolean)=>{fail=value;}};
  }
  it('reuses decoded finalized transactions while refreshing signature finality every poll',async()=>{
    const env=readerFixture();expect((await env.reader.events(env.address))[0].action).toBe('claimJob');await env.reader.events(env.address);expect(env.calls()).toBe(1);expect(env.polls()).toBe(2);
    env.fail(true);await expect(env.reader.events(env.address)).rejects.toThrow('signatures RPC failed');expect(env.calls()).toBe(1);
  });
  it('does not cache confirmed or missing transaction bodies and retries after finality recovery',async()=>{
    const env=readerFixture();env.set([{signature:'unit-1',slot:10,blockTime:100,err:null,confirmationStatus:'confirmed'}]);await env.reader.events(env.address);await env.reader.events(env.address);expect(env.calls()).toBe(2);
    env.set([{signature:'unit-1',slot:10,blockTime:100,err:null,confirmationStatus:'finalized'}]);env.missing(true);await env.reader.events(env.address);env.missing(false);await env.reader.events(env.address);await env.reader.events(env.address);expect(env.calls()).toBe(4);
  });
  it('binds cached actions to the IDL named job and never to an unrelated remaining account',async()=>{
    const env=readerFixture();expect((await env.reader.events(env.remaining))[0].action).toBeUndefined();expect((await env.reader.events(env.address))[0].action).toBe('claimJob');expect(env.calls()).toBe(1);
  });
  it('bounds finalized decode cache and coalesces transaction loads across overlapping event polls',async()=>{
    const env=readerFixture(1);await Promise.all([env.reader.events(env.address),env.reader.events(env.address)]);expect(env.calls()).toBe(1);
    env.set([{signature:'unit-2',slot:11,blockTime:100,err:null,confirmationStatus:'finalized'}]);await env.reader.events(env.address);env.set([{signature:'unit-1',slot:10,blockTime:100,err:null,confirmationStatus:'finalized'}]);await env.reader.events(env.address);expect(env.calls()).toBe(3);
  });
  it('staggers startup and bounds service backoff before recovering',async()=>{
    const delays:number[]=[],health:boolean[]=[];let reads=0;
    const options:ServiceOptions={role:'verifier',wallet:'v',mint:'m',verifier:'v',outputDir:'.',inputPolicy:{allowedOrigins:[]},getSpec:async()=>null,settle:async()=>{},heartbeat:value=>{health.push(value.healthy);},client:{listJobs:async()=>{if(++reads===1)throw Error('RPC429');return [];},getJob:async()=>null,claimJob:async()=>'',submitWork:async()=>'',approveWork:async()=>'',rejectWork:async()=>''}};
    await watchService(options,{initialDelayMs:6000,intervalMs:15000,maxPasses:3,sleep:async ms=>{delays.push(ms);}});expect(delays).toEqual([6000,30000,15000]);expect(health).toEqual([false,true,true]);
  });
});
