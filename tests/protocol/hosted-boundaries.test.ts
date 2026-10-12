import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { sendDurableTransaction } from '../../packages/agent-runtime/src/transaction-journal.ts';
import { createApi, type ApiConfig } from '../../apps/api/src/server.ts';
import { MetadataStore } from '../../apps/api/src/store.ts';
import { sha256 } from '../../packages/shared/src/index.ts';
import type { ChainReader, ChainJob } from '../../apps/api/src/indexer.ts';

const roots:string[]=[];
const close:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of close.splice(0))await fn();for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});

it('overlapping financial operations install one journal and broadcast only its one signed transaction', async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentbond-independent-journal-'));roots.push(root);
  const wallet=Keypair.generate(),recipient=Keypair.generate().publicKey,path=join(root,'operation.json');
  const hashes=[Keypair.generate().publicKey.toBase58(),Keypair.generate().publicKey.toBase58()];
  const broadcasts=new Set<string>();let latestCalls=0;
  type Latest={blockhash:string;lastValidBlockHeight:number};
  let releaseFirst!:(value:Latest)=>void,releaseSecond!:(value:Latest)=>void;
  const first=new Promise<Latest>(resolve=>releaseFirst=resolve),second=new Promise<Latest>(resolve=>releaseSecond=resolve);
  const rpc={
    getLatestBlockhash:async()=>{latestCalls++;if(latestCalls===1)return first;releaseFirst({blockhash:hashes[0],lastValidBlockHeight:100});return second;},
    getSignatureStatuses:async(signatures:string[])=>({value:signatures.map(signature=>broadcasts.has(signature)?{err:null,slot:1,confirmationStatus:'finalized'}:null)}),
    getBlockHeight:async()=>0,isBlockhashValid:async()=>({value:true}),
    sendRawTransaction:async(raw:Buffer)=>{const tx=Transaction.from(raw),signature=bs58.encode(tx.signature!);broadcasts.add(signature);releaseSecond({blockhash:hashes[1],lastValidBlockHeight:100});return signature;},
  } as unknown as Connection;
  const transfer=()=>new Transaction().add(SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:recipient,lamports:1}));
  const results=await Promise.all([sendDurableTransaction(rpc,transfer(),wallet,path,'same-authorized-effect',{polls:4,intervalMs:1}),sendDurableTransaction(rpc,transfer(),wallet,path,'same-authorized-effect',{polls:4,intervalMs:1})]);
  expect(results.every(result=>result.state==='CONFIRMED')).toBe(true);
  expect(broadcasts.size,'Two independently signed transfers must never be broadcast for one authorization').toBe(1);
  expect(results[0].signature).toBe(results[1].signature);
});

async function httpFixture(config:Partial<ApiConfig>={},reader?:ChainReader) {
  const root=await mkdtemp(join(tmpdir(),'agentbond-independent-http-'));roots.push(root);
  const store=new MetadataStore(join(root,'metadata.json'));await store.load();
  const recipients:string[]=[];
  const api=createApi({config:{programId:Keypair.generate().publicKey.toBase58(),mint:Keypair.generate().publicKey.toBase58(),network:'devnet',rpcUrl:'https://api.devnet.solana.com',faucetEnabled:true,metadataWrites:true,writesEnabled:true,...config},store,artifactRoot:root,reader:reader??{listJobs:async()=>[],getJob:async()=>null,events:async()=>[]},faucet:{request:async wallet=>{recipients.push(wallet);return {testOnly:true};}}});
  api.server.listen(0,'127.0.0.1');await once(api.server,'listening');
  close.push(async()=>{api.server.closeAllConnections();await new Promise<void>(resolve=>api.server.close(()=>resolve()));});
  const origin=`http://127.0.0.1:${(api.server.address() as {port:number}).port}`;
  function authorization(wallet:Keypair,raw:string,action:'request-faucet'|'job-metadata'='request-faucet') {
    const challenge=api.auth.challenge({wallet:wallet.publicKey.toBase58(),action,bodyHash:sha256(raw)});
    const signature=Buffer.from(nacl.sign.detached(Buffer.from(challenge.message),wallet.secretKey)).toString('base64');
    return 'AgentBond '+Buffer.from(JSON.stringify({wallet:wallet.publicKey.toBase58(),nonce:challenge.nonce,signature})).toString('base64');
  }
  const post=(raw:string,auth?:string)=>fetch(origin+'/faucet',{method:'POST',body:raw,headers:{'content-type':'application/json',...(auth?{authorization:auth}:{})}});
  return {recipients,post,authorization,api,origin};
}
it('rejects signed faucet recipient substitution and accepts only the signing wallet once per nonce',async()=>{
  const f=await httpFixture(),signer=Keypair.generate(),other=Keypair.generate();
  const substituted=JSON.stringify({wallet:other.publicKey.toBase58()});
  expect((await f.post(substituted,f.authorization(signer,substituted))).status).toBe(403);expect(f.recipients).toEqual([]);
  const raw=JSON.stringify({wallet:signer.publicKey.toBase58()}),authorization=f.authorization(signer,raw);
  expect((await f.post(raw,authorization)).status).toBe(200);
  expect((await f.post(raw,authorization)).status).toBe(401);
  expect(f.recipients).toEqual([signer.publicKey.toBase58()]);
});
it('does not accept another signed action or a changed body as faucet authorization',async()=>{
  const f=await httpFixture(),signer=Keypair.generate(),raw=JSON.stringify({wallet:signer.publicKey.toBase58()});
  expect((await f.post(raw,f.authorization(signer,raw,'job-metadata'))).status).toBe(401);
  expect((await f.post(raw+' ',f.authorization(signer,raw))).status).toBe(401);
  expect(f.recipients).toEqual([]);
});
it.each([{writesEnabled:false},{metadataWrites:false},{faucetEnabled:false}])('honors disabled public mutation flags %j before any funding call',async config=>{
  const f=await httpFixture(config),signer=Keypair.generate(),raw=JSON.stringify({wallet:signer.publicKey.toBase58()});
  expect((await f.post(raw,f.authorization(signer,raw))).status).toBe(503);expect(f.recipients).toEqual([]);
});
it('reclaims SSE capacity when clients disconnect during the initial RPC read',async()=>{
  const address=Keypair.generate().publicKey.toBase58();
  const job:ChainJob={address,status:'FUNDED',creator:address,worker:null,verifier:address,amount:'1',specHash:'0'.repeat(64),acceptanceHash:'0'.repeat(64),artifactHash:'0'.repeat(64),verificationHash:'0'.repeat(64)};
  let calls=0,block=true,entered!:()=>void,release!:()=>void;
  const f=await httpFixture({}, {listJobs:async()=>[job],events:async()=>[],getJob:async()=>{calls++;if(block&&calls%2===0){entered();await new Promise<void>(resolve=>release=resolve);}return job;}});
  for(let attempt=0;attempt<8;attempt++) {
    const pending=new Promise<void>(resolve=>entered=resolve);
    const closed=new Promise<void>(resolve=>f.api.server.once('request',(_req,res)=>res.once('close',()=>resolve())));
    const controller=new AbortController();
    const request=fetch(f.origin+`/jobs/${address}/events`,{headers:{accept:'text/event-stream'},signal:controller.signal}).catch(()=>null);
    await pending;controller.abort();await request;await closed;release();await new Promise<void>(resolve=>setImmediate(resolve));
  }
  block=false;
  const controller=new AbortController();
  const response=await fetch(f.origin+`/jobs/${address}/events`,{headers:{accept:'text/event-stream'},signal:controller.signal});
  expect(response.status,'Disconnected clients must not permanently consume all eight SSE slots').toBe(200);
  controller.abort();
});
