import { afterEach,expect,it,vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();});
async function fixture(responses:(attempt:number,body:Record<string,unknown>)=>Response=(attempt,body)=>Response.json({jsonrpc:'2.0',id:body.id,result:'test-genesis'})) {
  vi.resetModules();
  const {createReadOnlyRpcConnection}=await import('../../scripts/read-only-rpc.ts');
  vi.useFakeTimers();vi.setSystemTime(0);
  const starts:number[]=[],bodies:string[]=[],signals:AbortSignal[]=[];
  const fetch=vi.fn(async(_input:unknown,init?:RequestInit)=>{starts.push(Date.now());bodies.push(String(init?.body));signals.push(init!.signal!);return responses(starts.length-1,JSON.parse(String(init?.body)));});
  vi.stubGlobal('fetch',fetch);
  return {connection:createReadOnlyRpcConnection('https://api.devnet.solana.com'),other:createReadOnlyRpcConnection('https://api.devnet.solana.com'),starts,bodies,signals,fetch};
}
it('paces concurrent reads across distinct returned Connections, not just within each instance',async()=>{
  const f=await fixture();
  const reads=[f.connection.getGenesisHash(),f.other.getGenesisHash(),f.connection.getGenesisHash()];
  await vi.advanceTimersByTimeAsync(0);expect(f.starts).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1099);expect(f.starts).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);expect(f.starts).toEqual([0,1100]);
  await vi.advanceTimersByTimeAsync(1100);await Promise.all(reads);expect(f.starts).toEqual([0,1100,2200]);
});
it('retries only the same read body on429 at2s then4s and stops after three attempts',async()=>{
  const f=await fixture(()=>new Response('rate limit',{status:429}));
  const read=f.connection.getGenesisHash();const failure=expect(read).rejects.toThrow(/429/);
  await vi.advanceTimersByTimeAsync(6000);await failure;
  expect(f.starts).toEqual([0,2000,6000]);expect(new Set(f.bodies).size).toBe(1);
});
it('respects a bounded numeric Retry-After and still uses the shared start queue',async()=>{
  const f=await fixture((attempt,body)=>attempt===0?new Response('rate limit',{status:429,headers:{'Retry-After':'5'}}):Response.json({jsonrpc:'2.0',id:body.id,result:'test-genesis'}));
  const read=f.connection.getGenesisHash();await vi.advanceTimersByTimeAsync(0);
  const other=f.other.getGenesisHash();await vi.advanceTimersByTimeAsync(1100);expect(f.starts).toEqual([0]);
  await vi.advanceTimersByTimeAsync(3900);await other;
  await vi.advanceTimersByTimeAsync(1100);await read;
  expect(f.starts).toEqual([0,5000,6100]);expect(f.bodies[0]).toBe(f.bodies[2]);
});
it('honors HTTP-date Retry-After and refuses an over-bound server cooldown without early retry',async()=>{
  const f=await fixture(()=>new Response('rate limit',{status:429,headers:{'Retry-After':new Date(6000).toUTCString()}}));
  const read=f.connection.getGenesisHash(),failure=expect(read).rejects.toThrow(/429/);
  await vi.advanceTimersByTimeAsync(10000);await failure;expect(f.starts).toEqual([0,6000,10000]);
  const other=await fixture(()=>new Response('rate limit',{status:429,headers:{'Retry-After':'60'}}));
  const long=other.connection.getGenesisHash(),longFailure=expect(long).rejects.toThrow(/429/);
  await vi.advanceTimersByTimeAsync(0);await longFailure;expect(other.starts).toEqual([0]);
  await expect(other.other.getGenesisHash()).rejects.toThrow(/cooldown exceeds/);expect(other.starts).toEqual([0]);
});
it('refuses faucet and transaction writes before any HTTP transport or budget reservation',async()=>{
  const f=await fixture();
  await expect(f.connection.requestAirdrop(PublicKey.unique(),1)).rejects.toThrow(/refused before transport/);
  await expect(f.connection.sendRawTransaction(Buffer.from([1,2,3]))).rejects.toThrow(/refused before transport/);
  expect(f.fetch).not.toHaveBeenCalled();
  const read=f.connection.getGenesisHash();await vi.advanceTimersByTimeAsync(0);await read;expect(f.starts).toEqual([0]);
});
it('permits blockhash-validity reads and applies a fresh15s abort signal to transport',async()=>{
  const f=await fixture((_attempt,body)=>Response.json({jsonrpc:'2.0',id:body.id,result:{context:{slot:1},value:true}}));
  const read=f.connection.isBlockhashValid(PublicKey.unique().toBase58());await vi.advanceTimersByTimeAsync(0);
  expect((await read).value).toBe(true);expect(f.signals[0]).toBeInstanceOf(AbortSignal);expect(f.signals[0].aborted).toBe(false);
});
it('aborts an unresponsive transport after15s without retrying a network failure',async()=>{
  const f=await fixture();
  // Make the platform timeout signal deterministic under fake timers.
  vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const controller=new AbortController();setTimeout(()=>controller.abort(new Error('network deadline')),ms);return controller.signal;});
  f.fetch.mockImplementation(async(_input,init)=>new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true})));
  const read=f.connection.getGenesisHash(),failure=expect(read).rejects.toThrow('network deadline');let rejected=false;void read.catch(()=>{rejected=true;});
  await vi.advanceTimersByTimeAsync(14999);expect(rejected).toBe(false);
  await vi.advanceTimersByTimeAsync(1);await failure;expect(f.fetch).toHaveBeenCalledTimes(1);
});
