import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {Connection} from '@solana/web3.js';
const url=process.env.WEB_URL;
if(!url)throw new Error('WEB_URL is required.');
const localDevnet=process.env.AGENTBOND_LOCAL_DEVNET==='1'&&/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/|$)/.test(url??'');
const videoPath=localDevnet?'artifacts/web/agentbond-local-devnet-ui.webm':'artifacts/web/agentbond-devnet-ui.webm';
const evidencePath=localDevnet?'artifacts/web/local-devnet-video-evidence.json':'artifacts/web/devnet-video-evidence.json';
const screenshotPrefix=localDevnet?'artifacts/web/local-devnet-record-':'artifacts/web/devnet-record-';
if(!url?.startsWith('https://')&&!localDevnet)throw new Error('WEB_URL must be the verified HTTPS public deployment.');
const json=async(path:string)=>{const response=await fetch(url+'/api'+path,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error(path+' returned '+response.status);return response.json()};
const config=await json('/config');
if(config.network!=='devnet')throw new Error('Only an actual configured devnet deployment can be recorded.');
if(await new Connection(config.rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15000)})}).getGenesisHash()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw new Error('RPC genesis does not match devnet.');
const {jobs}=await json('/jobs');
const settled=jobs.find((job:{address:string;status:string;mint:string;metadata?:{spec?:unknown}})=>job.status==='SETTLED'&&job.mint===config.mint&&job.metadata?.spec&&(!process.argv[2]||job.address===process.argv[2]));
const refunded=jobs.find((job:{status:string;mint:string;metadata?:{spec?:unknown}})=>job.status==='REFUNDED'&&job.mint===config.mint&&job.metadata?.spec);
if(!settled||!refunded)throw new Error('Recording requires actual settled and refunded jobs with committed metadata.');
await mkdir('artifacts/web/devnet-video',{recursive:true});
const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:'artifacts/web/devnet-video',size:{width:1440,height:1000}}});
const page=await context.newPage();page.setDefaultTimeout(15000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
const outcome:Record<string,unknown>={url,deployment:localDevnet?'local-production':'public',network:'devnet',programId:config.programId,mint:config.mint,settledJob:settled.address,refundedJob:refunded.address,footage:'Actual current chain state and completed transaction history; no simulated or manufactured lifecycle states.',startedAt:new Date().toISOString(),status:'recording'};
const video=page.video()!;
try{
 const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});expect(response?.status()).toBe(200);await page.waitForSelector('.job-card');
 await page.screenshot({path:screenshotPrefix+'landing.png',fullPage:true});await page.waitForTimeout(3500);
 await page.getByRole('button',{name:'Marketplace',exact:true}).click();await page.getByRole('textbox',{name:'Search jobs'}).fill(settled.address);await page.locator('.job-card').first().click();
 await expect(page.locator('.page-title .status')).toHaveText('SETTLED');await expect(page.locator('.step.done')).toHaveCount(6);await page.waitForTimeout(5000);
 await expect(page.locator('.events a')).toHaveCount(6);await page.locator('.events').scrollIntoViewIfNeeded();await page.waitForTimeout(3500);await page.screenshot({path:screenshotPrefix+'transaction-history.png',fullPage:true});outcome.transactionHistoryObserved=true;outcome.transactionHistoryLabels='Actual confirmed transaction signatures; the UI uses generic confirmed transaction labels.';
 await expect(page.locator('.code-block').last()).toContainText('"matchesChainCommitment": true');await page.getByRole('heading',{name:'Artifact & verification receipt'}).scrollIntoViewIfNeeded();await page.waitForTimeout(4000);await page.locator('.code-block').last().evaluate(element=>{element.scrollTop=element.scrollHeight});await page.waitForTimeout(4000);
 await page.screenshot({path:screenshotPrefix+'settled.png',fullPage:true});
 const explorerUrl=await page.locator('.events a').first().getAttribute('href');if(!explorerUrl||!explorerUrl.startsWith('https://explorer.solana.com/tx/')||!explorerUrl.includes('cluster=devnet'))throw new Error('Actual devnet Explorer transaction link is required.');const transactionSignature=new URL(explorerUrl).pathname.split('/').pop()!;await page.goto(explorerUrl,{waitUntil:'domcontentloaded',timeout:20000});await expect(page.locator('body')).toContainText(transactionSignature,{timeout:20000});await expect(page.locator('body')).toContainText(/Success|Finalized|Confirmed/,{timeout:20000});await page.waitForTimeout(3500);await page.screenshot({path:screenshotPrefix+'explorer.png',fullPage:true});Object.assign(outcome,{explorerUrl,explorerTransaction:transactionSignature,explorerObserved:true});
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});await page.waitForSelector('.job-card');
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.getByRole('button',{name:'Marketplace',exact:true}).click();await page.getByRole('textbox',{name:'Search jobs'}).fill(refunded.address);await page.locator('.job-card').first().click();await expect(page.locator('.page-title .status')).toHaveText('REFUNDED');await page.waitForTimeout(5000);await page.screenshot({path:screenshotPrefix+'refund.png',fullPage:true});
 await page.getByRole('button',{name:'Dashboard',exact:true}).click();await page.waitForTimeout(3000);expect(errors).toEqual([]);outcome.status='passed';
}catch(error){Object.assign(outcome,{status:'failed',error:error instanceof Error?error.message:String(error)});process.exitCode=1}
finally{
 await page.close();await context.close();await copyFile(await video.path(),videoPath);await browser.close();Object.assign(outcome,{pageErrors:errors,video:videoPath,finishedAt:new Date().toISOString()});
 const probe=JSON.parse(execFileSync('/opt/homebrew/bin/ffprobe',['-v','error','-show_entries','format=duration,size','-of','json',videoPath],{encoding:'utf8'}));outcome.durationSeconds=Number(probe.format.duration);outcome.bytes=Number(probe.format.size);if(Number(probe.format.duration)>180){outcome.status='failed';outcome.error='Actual recording exceeds three minutes';process.exitCode=1}
 outcome.recordingPolicy='Historical completed lifecycle with actual devnet transactions; no extension wallet interaction is depicted.';await writeFile(evidencePath,JSON.stringify(outcome,null,2));console.log(JSON.stringify(outcome));
}
