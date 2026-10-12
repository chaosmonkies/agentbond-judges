import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { createApi } from '../../apps/api/src/server.ts';
import { MetadataStore } from '../../apps/api/src/store.ts';
import { fetchInput } from '../../packages/agent-runtime/src/input.ts';
import { executeCsv } from '../../packages/agent-runtime/src/execute.ts';
import { verifyArtifact } from '../../apps/verifier/src/verify.ts';
import { sha256, specificationHashes, type JobSpec } from '../../packages/shared/src/index.ts';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
const creator=Keypair.generate(),attacker=Keypair.generate(),address=Keypair.generate().publicKey.toBase58();
const input=Buffer.from('note,revenue\n"require(fs).readFileSync(secret)",10\n"$(curl http://169.254.169.254/latest/meta-data)",200\n');
const spec:JobSpec={type:'csv-analysis',input:{url:'http://127.0.0.1:4100/inputs/a.csv',hash:sha256(input)},acceptance:{numericColumns:['revenue'],anomaly:{column:'revenue',threshold:100,direction:'above'}}};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'agentbond-security-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const artifactRoot=join(root,'artifacts');await mkdir(artifactRoot);
  const store=new MetadataStore(join(root,'metadata.json'));await store.load();
  const chainJob={address,status:'SUBMITTED',creator:creator.publicKey.toBase58(),worker:attacker.publicKey.toBase58(),verifier:Keypair.generate().publicKey.toBase58(),amount:'100',...specificationHashes(spec),artifactHash:'00'.repeat(32),verificationHash:'00'.repeat(32)};
  const api=createApi({config:{programId:address,mint:address,network:'localnet',rpcUrl:'http://127.0.0.1:8899'},store,artifactRoot,reader:{listJobs:async()=>[chainJob],getJob:async a=>a===address?chainJob:null,events:async()=>[]}});
  api.server.listen(0,'127.0.0.1');await once(api.server,'listening');cleanup.push(()=>new Promise<void>(resolve=>api.server.close(()=>resolve())));
  const origin=`http://127.0.0.1:${(api.server.address() as {port:number}).port}`;
  async function authorized(wallet:Keypair,action:'register-agent'|'job-metadata',body:unknown){
    const raw=JSON.stringify(body);
    const response=await fetch(origin+'/auth/challenge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:wallet.publicKey.toBase58(),action,bodyHash:sha256(raw)})});
    expect(response.status).toBe(200);const challenge=await response.json() as {nonce:string;message:string};
    const signature=Buffer.from(nacl.sign.detached(Buffer.from(challenge.message),wallet.secretKey)).toString('base64');
    const authorization='AgentBond '+Buffer.from(JSON.stringify({wallet:wallet.publicKey.toBase58(),nonce:challenge.nonce,signature})).toString('base64');
    return {raw,headers:{'content-type':'application/json',authorization}};
  }
  return {root,artifactRoot,store,api,origin,authorized,chainJob};
}
describe('independent security attacks against real HTTP and execution boundaries',()=>{
  it('rejects anonymous metadata mutation and forged agent registration',async()=>{
    const f=await fixture();
    for(const path of ['/jobs','/agents/register'])expect((await fetch(f.origin+path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401);
    expect(f.store.jobs()).toEqual([]);expect(f.store.agents()).toEqual([]);
  });
  it('binds actual POST metadata to creator, exact body, chain commitment and single-use nonce',async()=>{
    const f=await fixture(),body={address,title:'Legitimate metadata',spec};
    const bad=await f.authorized(attacker,'job-metadata',body);
    expect((await fetch(f.origin+'/jobs',{method:'POST',headers:bad.headers,body:bad.raw})).status).toBe(403);
    const signed=await f.authorized(creator,'job-metadata',body);
    expect((await fetch(f.origin+'/jobs',{method:'POST',headers:signed.headers,body:signed.raw+' '})).status).toBe(401);
    expect((await fetch(f.origin+'/jobs',{method:'POST',headers:signed.headers,body:signed.raw})).status).toBe(201);
    expect((await fetch(f.origin+'/jobs',{method:'POST',headers:signed.headers,body:signed.raw})).status).toBe(401);
    const altered={...body,spec:{...spec,input:{...spec.input,hash:'ff'.repeat(32)}}},signedAltered=await f.authorized(creator,'job-metadata',altered);
    expect((await fetch(f.origin+'/jobs',{method:'POST',headers:signedAltered.headers,body:signedAltered.raw})).status).toBe(409);
    const injected={...body,artifactPath:'/outside/private-key.json'},signedInjected=await f.authorized(creator,'job-metadata',injected);
    expect((await fetch(f.origin+'/jobs',{method:'POST',headers:signedInjected.headers,body:signedInjected.raw})).status).toBe(400);
    expect(f.store.job(address)?.title).toBe('Legitimate metadata');
  });
  it('consumes a signed nonce atomically under concurrent HTTP replay',async()=>{
    const f=await fixture(),body={address,spec},signed=await f.authorized(creator,'job-metadata',body);
    const replies=await Promise.all(Array.from({length:8},()=>fetch(f.origin+'/jobs',{method:'POST',headers:signed.headers,body:signed.raw})));
    expect(replies.filter(r=>r.status===201)).toHaveLength(1);expect(replies.filter(r=>r.status===401)).toHaveLength(7);
  });
  it('prevents concurrent new-agent ID takeover by a second valid wallet',async()=>{
    const f=await fixture();
    const profile=(wallet:Keypair)=>({id:'shared-name',wallet:wallet.publicKey.toBase58(),capabilities:['csv'],taskTypes:['csv-analysis'],maxRuntimeMs:2000});
    const [one,two]=await Promise.all([f.authorized(creator,'register-agent',profile(creator)),f.authorized(attacker,'register-agent',profile(attacker))]);
    const replies=await Promise.all([one,two].map(s=>fetch(f.origin+'/agents/register',{method:'POST',headers:s.headers,body:s.raw})));
    expect(replies.map(r=>r.status).sort()).toEqual([201,403]);
    const winner=await replies.find(r=>r.status===201)!.json() as {agent:{wallet:string}};
    expect(f.store.agents()).toHaveLength(1);expect(f.store.agents()[0].wallet).toBe(winner.agent.wallet);
  });
  it('blocks artifact symlink escape without disclosing a private sentinel',async()=>{
    const f=await fixture(),outside=join(f.root,'private-sentinel.json'),inside=join(f.artifactRoot,'link.json');
    await writeFile(outside,JSON.stringify({privateSentinel:'THIS_MUST_NEVER_BE_SENT'}));await symlink(outside,inside);
    await f.store.putJob({address,spec,artifactPath:inside});
    const response=await fetch(f.origin+`/jobs/${address}/artifacts`);
    expect(response.status).toBe(403);expect(await response.text()).not.toContain('THIS_MUST_NEVER_BE_SENT');
  });
  it('rejects oversized JSON bodies and artifact files',async()=>{
    const f=await fixture();
    const response=await fetch(f.origin+'/auth/challenge',{method:'POST',body:'x'.repeat(65537)});expect(response.status).toBe(413);
    const file=join(f.artifactRoot,'huge.json');await writeFile(file,'x'.repeat(2*1024*1024+1));await f.store.putJob({address,spec,artifactPath:file});
    expect((await fetch(f.origin+`/jobs/${address}/artifacts`)).status).toBe(413);
  });
  it.each(['http://169.254.169.254/latest/meta-data','http://10.0.0.1/private','http://[::ffff:127.0.0.1]/private','http://127.1/private','http://2130706433/private'])('rejects pinned private/metadata SSRF %s',async url=>{
    await expect(fetchInput(url,'00'.repeat(32),{allowedOrigins:[new URL(url).origin]})).rejects.toThrow('Private network');
  });
  it('keeps command-bearing CSV text inert and independently rejects changed-but-rehashed output',async()=>{
    const result=await executeCsv(input,spec);expect(result.columns.revenue.sum).toBe(210);
    const bytes=Buffer.from(JSON.stringify(result));expect(verifyArtifact(input,bytes,sha256(bytes),spec).approved).toBe(true);
    result.columns.revenue.sum=0;const tampered=Buffer.from(JSON.stringify(result));
    expect(verifyArtifact(input,tampered,sha256(tampered),spec).approved).toBe(false);
  });
  it('enforces filesystem and process restrictions and excludes signing secrets from child environment',async()=>{
    const script=`const checks=[];for(const test of [()=>require('node:fs').readFileSync('/etc/passwd'),()=>require('node:child_process').spawnSync('echo',['leak'])]){try{test();checks.push(false)}catch(e){checks.push(e.code==='ERR_ACCESS_DENIED')}}console.log(JSON.stringify({checks,secret:process.env.AGENTBOND_SECURITY_SENTINEL}))`;
    const text=await new Promise<string>((resolve,reject)=>{const child=spawn(process.execPath,['--permission','-e',script],{env:{},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(new Error(err)));});
    expect(JSON.parse(text)).toEqual({checks:[true,true]});
  });
});
