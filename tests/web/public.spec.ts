import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Connection,PublicKey} from '@solana/web3.js';
import {AgentBondClient,PROGRAM_ID,type Wallet,type JobDTO} from '../../packages/sdk/src/index';
const publicUrl=process.env.WEB_URL??'';
const localDevnet=process.env.AGENTBOND_LOCAL_DEVNET==='1'&&/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/|$)/.test(publicUrl);
const mode=process.env.AGENTBOND_PUBLIC_MODE??'unconfigured';
if(!['unconfigured','devnet'].includes(mode))throw new Error('AGENTBOND_PUBLIC_MODE must be unconfigured or devnet.');
const isPublic=/^https:\/\//.test(publicUrl)&&!/^https:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(publicUrl);
test.describe('public preview smoke',()=>{
 test.skip(!isPublic&&!localDevnet,'Public preview smoke requires WEB_URL=https://<public-host>. Local wallet tests remain separate.');
 test('published UI honestly exposes unconfigured chain state and blocks signing',async({page,request})=>{
  test.skip(mode!=='unconfigured'||localDevnet,'Run with AGENTBOND_PUBLIC_MODE=unconfigured for the preview without chain configuration.');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const navigation=await page.goto('/',{waitUntil:'domcontentloaded',timeout:20000});expect(navigation?.status()).toBe(200);
  await expect(page.getByRole('heading',{name:'Agents can work. Now they can hire.'})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'Primary'})).toBeVisible();
  const config=await request.get(publicUrl+'/api/config');expect(config.status()).toBe(503);
  const configBody=await config.json();expect(configBody.error).toContain('configuration');
  const jobs=await request.get(publicUrl+'/api/jobs');expect(jobs.status()).toBe(503);
  await expect(page.getByRole('alert').filter({hasText:'Network configuration'})).toContainText('configuration');
  await expect(page.locator('.job-card')).toHaveCount(0);
  await expect(page.locator('.metric strong').nth(0)).toHaveText('—');
  await expect(page.locator('.metric strong').nth(1)).toHaveText('—');
  await expect(page.locator('.metric strong').nth(2)).toHaveText('—');
  await page.screenshot({path:'artifacts/web/public-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Explore marketplace'}).click();
  await expect(page.getByRole('heading',{name:'Find the next piece of work.'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Marketplace unavailable'})).toBeVisible();
  await expect(page.locator('.job-card')).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'artifacts/web/public-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Create a job +'}).click();
  await expect(page.getByRole('heading',{name:'Make the brief executable.'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Connect wallet to create',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Live demo',exact:true}).click();
  await expect(page.locator('.step.done')).toHaveCount(0);
  await expect(page.locator('.job-card')).toHaveCount(0);
  await page.getByRole('button',{name:'Dashboard',exact:true}).click();
  await expect(page.locator('.dashboard-states strong').first()).toHaveText('—');
  expect(errors).toEqual([]);
  await writeFile('artifacts/web/public-smoke.json',JSON.stringify({url:publicUrl,documentStatus:navigation?.status(),configStatus:config.status(),jobsStatus:jobs.status(),configurationError:configBody.error,noSyntheticJobs:true,noSyntheticMetrics:true,noSyntheticSettlement:true,createSigningDisabled:true,mobileOverflow:false,pageErrors:errors,screenshots:['artifacts/web/public-desktop.png','artifacts/web/public-mobile.png'],verifiedAt:new Date().toISOString()},null,2));
 });
 test('configured devnet deployment reconciles chain state, raw evidence and public UI',async({page,request})=>{
  test.skip(mode!=='devnet','Configured devnet verification requires AGENTBOND_PUBLIC_MODE=devnet.');
  test.setTimeout(120000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const evidenceFile=localDevnet?'artifacts/web/local-devnet-smoke.json':'artifacts/web/public-devnet-smoke.json';
  const outcome:Record<string,unknown>={url:publicUrl,deployment:localDevnet?'local-production':'public',mode:'devnet',status:'running',startedAt:new Date().toISOString()};
  await writeFile(evidenceFile,JSON.stringify(outcome,null,2));
  try{
   const configResponse=await request.get(publicUrl+'/api/config',{timeout:15000});expect(configResponse.status()).toBe(200);
   const config=await configResponse.json();expect(config.network).toBe('devnet');expect(config.programId).toBe(PROGRAM_ID.toBase58());expect(config.metadataWrites).toBe(false);
   const connection=new Connection(config.rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15000)})});
   expect(await connection.getGenesisHash()).toBe('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
   const deployed=await connection.getAccountInfo(new PublicKey(config.programId));expect(deployed?.executable).toBe(true);
   const readWallet={publicKey:PublicKey.default,signTransaction:async()=>{throw new Error('Read-only verifier cannot sign')},signAllTransactions:async()=>{throw new Error('Read-only verifier cannot sign')}} as Wallet;
   const sdk=new AgentBondClient(connection,readWallet,new PublicKey(config.programId));
   const chainJobs=await sdk.listJobs();expect(chainJobs.length).toBeGreaterThan(0);
   const jobsResponse=await request.get(publicUrl+'/api/jobs',{timeout:20000});expect(jobsResponse.status()).toBe(200);
   const jobsBody=await jobsResponse.json();const jobs=jobsBody.jobs as Array<JobDTO&{metadata?:{title?:string;spec?:unknown}}>;
   expect(jobsBody.authority).toBe('chain');expect(jobs.length).toBe(chainJobs.length);
   for(const job of jobs)expect(chainJobs.find(chain=>chain.address===job.address)).toEqual(expect.objectContaining({id:job.id,status:job.status,creator:job.creator,worker:job.worker,verifier:job.verifier,vault:job.vault,tokenProgram:job.tokenProgram,mint:job.mint,amount:job.amount,specHash:job.specHash,acceptanceHash:job.acceptanceHash,artifactHash:job.artifactHash,verificationHash:job.verificationHash}));
   const settled=jobs.find(job=>job.mint===config.mint&&job.status==='SETTLED'&&job.metadata?.spec);
   const refunded=jobs.find(job=>job.mint===config.mint&&job.status==='REFUNDED'&&job.metadata?.spec);
   expect(settled,'An actual settled demo job is required').toBeTruthy();expect(refunded,'An actual refunded demo job is required').toBeTruthy();
   const statsResponse=await request.get(publicUrl+'/api/stats',{timeout:20000});expect(statsResponse.status()).toBe(200);const stats=await statsResponse.json();
   expect(stats.authority).toBe('chain');expect(stats.totalJobs).toBe(chainJobs.length);expect(stats.settledJobs).toBe(chainJobs.filter(job=>job.status==='SETTLED').length);expect(stats.fundedJobs).toBe(chainJobs.filter(job=>['FUNDED','CLAIMED','SUBMITTED','VERIFIED'].includes(job.status)).length);const agentsResponse=await request.get(publicUrl+'/api/agents',{timeout:15000});expect(agentsResponse.status()).toBe(200);const agentsBody=await agentsResponse.json();expect(stats.registeredAgents).toBe(agentsBody.agents.length);const byStatus:Record<string,number>={};chainJobs.forEach(job=>byStatus[job.status]=(byStatus[job.status]??0)+1);expect(stats.byStatus).toEqual(byStatus);
   const proofs=[];
   for(const job of [settled!,refunded!]){
    const response=await request.get(publicUrl+'/api/jobs/'+job.address+'/artifacts',{timeout:20000});expect(response.status()).toBe(200);const envelope=await response.json();
    const hashes:Record<string,string>={};
    for(const kind of ['artifact','receipt'] as const){
     const rawResponse=await request.get(publicUrl+'/api/jobs/'+job.address+'/artifacts?raw='+kind,{timeout:20000});expect(rawResponse.status()).toBe(200);
     const raw=await rawResponse.body();const actualHash=createHash('sha256').update(raw).digest('hex');const expected=kind==='artifact'?job.artifactHash:job.verificationHash;
     expect(actualHash).toBe(expected);expect(envelope[kind].hash).toBe(actualHash);expect(envelope[kind].matchesChainCommitment).toBe(true);
     expect(JSON.parse(raw.toString('utf8'))).toEqual(envelope[kind].content);hashes[kind]=actualHash;
    }
    expect(envelope.receipt.content.jobAddress).toBe(job.address);expect(envelope.receipt.content.approved).toBe(job.status==='SETTLED');expect(envelope.receipt.content.artifactHash).toBe(job.artifactHash);proofs.push({address:job.address,status:job.status,hashes});
   }
   const navigation=await page.goto('/',{waitUntil:'domcontentloaded',timeout:20000});expect(navigation?.status()).toBe(200);
   await expect(page.getByRole('heading',{name:'Agents can work. Now they can hire.'})).toBeVisible();
   await expect(page.locator('.job-card').first()).toBeVisible();await expect(page.locator('.metric strong').first()).toHaveText(String(stats.totalJobs));
   await page.screenshot({path:'artifacts/web/'+(localDevnet?'devnet-local-':'devnet-public-')+'desktop.png',fullPage:true});
   await page.getByRole('button',{name:'Marketplace',exact:true}).click();await page.getByRole('textbox',{name:'Search jobs'}).fill(settled!.address);await page.locator('.job-card').first().click();
   await expect(page.locator('.page-title .status')).toHaveText('SETTLED');await expect(page.locator('.step.done')).toHaveCount(6);
   await expect(page.locator('.code-block').last()).toContainText('"matchesChainCommitment": true');
   await expect(page.locator('a[href*="'+settled!.address+'"]').first()).toHaveAttribute('href',/cluster=devnet/);
   const eventsResponse=await request.get(publicUrl+'/api/jobs/'+settled!.address+'/events',{timeout:20000});expect(eventsResponse.status()).toBe(200);const {events}=await eventsResponse.json();expect(events.length).toBeGreaterThan(0);
   const successfulEvents=events.filter((event:{err:unknown})=>event.err===null);expect(successfulEvents.length).toBeGreaterThanOrEqual(6);expect((await connection.getSignatureStatuses(successfulEvents.map((event:{signature:string})=>event.signature),{searchTransactionHistory:true})).value.every(status=>status&&status.err===null)).toBe(true);
   await page.screenshot({path:'artifacts/web/'+(localDevnet?'devnet-local-':'devnet-public-')+'settlement.png',fullPage:true});
   await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
   await page.screenshot({path:'artifacts/web/'+(localDevnet?'devnet-local-':'devnet-public-')+'mobile.png',fullPage:true});
   await page.getByRole('button',{name:'Marketplace',exact:true}).click();await page.getByRole('textbox',{name:'Search jobs'}).fill(refunded!.address);await page.locator('.job-card').first().click();await expect(page.locator('.page-title .status')).toHaveText('REFUNDED');
   await page.getByRole('button',{name:'Marketplace',exact:true}).click();await page.getByRole('button',{name:'Create a job +'}).click();
   await expect(page.getByRole('button',{name:'Connect wallet to create',exact:true})).toBeDisabled();expect(errors).toEqual([]);
   Object.assign(outcome,{status:'passed',documentStatus:navigation?.status(),configStatus:200,jobsStatus:200,statsStatus:200,network:config.network,programId:config.programId,mint:config.mint,actualJobCount:chainJobs.length,proofs,events:events.map((event:{signature:string})=>event.signature),metadataWrites:false,createSigningDisabled:true,mobileOverflow:false,pageErrors:errors});
  }catch(error){Object.assign(outcome,{status:'failed',error:error instanceof Error?error.message:String(error),pageErrors:errors});throw error}
  finally{outcome.finishedAt=new Date().toISOString();await writeFile(evidenceFile,JSON.stringify(outcome,null,2))}
 });
});
