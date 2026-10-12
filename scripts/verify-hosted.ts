import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress, getMint } from '@solana/spl-token';
import { AgentBondClient, type Wallet } from '../packages/sdk/src/index.ts';
import { DEVNET_PROFILE, explorerUrl, verifyNetworkGenesis } from '../packages/shared/src/network.ts';
import { jobSpecSchema, sha256, specificationHashes } from '../packages/shared/src/index.ts';
import { recoverJobTransactions, tokenBalanceSnapshot } from '../packages/agent-runtime/src/chain-evidence.ts';
import { verifyArtifact } from '../apps/verifier/src/verify.ts';
import { createReadOnlyRpcConnection } from './read-only-rpc.ts';

async function bytes(url:string) { const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});assert.equal(r.status,200,`HTTP ${new URL(url).pathname}`);return Buffer.from(await r.arrayBuffer()); }
async function json(url:string) { return JSON.parse((await bytes(url)).toString('utf8')); }
/** Read-only evidence checks. Local execution never counts as remote hosting. */
export async function verifyHostedWorkflow(options:{url:string;workflowFile:string;requirePublic?:boolean;rpc?:Connection}) {
  const url=new URL(options.url);
  assert(!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/','Supply a plain app origin');
  if (options.requirePublic!==false) assert(url.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Remote public HTTPS deployment required');
  const origin=url.origin, workflow=JSON.parse(await readFile(options.workflowFile,'utf8'));
  assert.equal(workflow.status,'passed');assert.equal(workflow.url,origin);assert.equal(workflow.network,'devnet');
  if (options.requirePublic!==false) assert.equal(workflow.deployment,'public');
  if (options.requirePublic!==false) assert(workflow.uploadExercised&&workflow.creationExercised&&workflow.fundingExercised&&!workflow.resumed,'Public release requires a fresh upload/create/fund workflow');
  const config=await json(origin+'/api/config'),health=await json(origin+'/api/health');
  for (const field of ['network','programId','mint','decimals','genesisHash']) assert.equal(config[field],DEVNET_PROFILE[field as keyof typeof DEVNET_PROFILE]);
  assert.equal(config.designatedVerifier,DEVNET_PROFILE.verifier);assert(config.metadataWrites&&config.writesEnabled&&config.inputUpload);
  assert(health.apiReady&&health.workersReady&&typeof health.bootId==='string','Current API and both hosted roles must be ready');
  for (const role of ['worker','verifier']) assert(health.services.some((service:any)=>service.service===role&&service.healthy&&!service.stale),'Healthy role missing');
  const rpc=options.rpc??createReadOnlyRpcConnection(config.rpcUrl);assert.equal(rpc.rpcEndpoint.replace(/\/$/,''),config.rpcUrl.replace(/\/$/,''));await verifyNetworkGenesis(DEVNET_PROFILE,rpc);
  const wallet:Wallet={publicKey:PublicKey.default,signTransaction:async()=>{throw new Error('Read only')},signAllTransactions:async()=>{throw new Error('Read only')}};
  const client=new AgentBondClient(rpc,wallet,new PublicKey(config.programId));
  const job=await client.getJob(workflow.job);assert(job&&job.status==='SETTLED'&&job.mint===config.mint&&job.verifier===DEVNET_PROFILE.verifier);
  const detail=await json(origin+'/api/jobs/'+job.address);assert.equal(detail.job.status,job.status);
  const spec=jobSpecSchema.parse(detail.metadata.spec),commitments=specificationHashes(spec);
  assert.equal(commitments.specHash,job.specHash);assert.equal(commitments.acceptanceHash,job.acceptanceHash);
  assert.equal(spec.input.url,origin+'/api/inputs/'+spec.input.hash+'.csv');
  const input=await bytes(spec.input.url);assert.equal(sha256(input),spec.input.hash);
  const artifact=await bytes(origin+'/api/jobs/'+job.address+'/artifacts?raw=artifact'),receipt=await bytes(origin+'/api/jobs/'+job.address+'/artifacts?raw=receipt');
  assert.equal(sha256(artifact),job.artifactHash);assert.equal(sha256(receipt),job.verificationHash);
  const recorded=JSON.parse(receipt.toString());assert(recorded.approved&&recorded.jobAddress===job.address&&recorded.specHash===job.specHash&&recorded.artifactHash===job.artifactHash&&recorded.inputHash===spec.input.hash);
  assert.equal(verifyArtifact(input,artifact,job.artifactHash,spec,job.address).approved,true);
  const mint=await getMint(rpc,new PublicKey(job.mint));assert.equal(mint.decimals,config.decimals);assert.equal(mint.freezeAuthority,null);
  const transactions=await recoverJobTransactions(rpc,client,job.address,signature=>explorerUrl(DEVNET_PROFILE,signature,'tx'));
  for (const action of ['create','fund','claim','submit','approve','settle']) assert.equal(transactions.filter(tx=>tx.action===action).length,1,`Exactly one successful ${action} instruction required`);
  const signatures=[...new Set(transactions.map(tx=>tx.signature))],statuses=(await rpc.getSignatureStatuses(signatures,{searchTransactionHistory:true})).value;
  assert(statuses.every(status=>status&&!status.err&&['confirmed','finalized'].includes(status.confirmationStatus??'')));
  const terminal=transactions.find(tx=>tx.action==='settle')!;
  const tx=await rpc.getTransaction(terminal.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});assert(tx);
  const recipient=await getAssociatedTokenAddress(new PublicKey(job.mint),new PublicKey(job.worker!));
  const deltas=tokenBalanceSnapshot(tx,{recipient:recipient.toBase58(),vault:job.vault},job.mint);
  assert.equal(BigInt(deltas.recipientAfter)-BigInt(deltas.recipientBefore),BigInt(job.amount));
  assert.equal(BigInt(deltas.vaultBefore)-BigInt(deltas.vaultAfter),BigInt(job.amount));assert.equal(deltas.vaultAfter,'0');assert.equal((await getAccount(rpc,new PublicKey(job.vault))).amount,0n);
  const unauthorized=await fetch(origin+'/api/inputs',{method:'POST',headers:{'Content-Type':'text/csv'},body:input,signal:AbortSignal.timeout(15000)});assert.equal(unauthorized.status,401);
  const agents=await json(origin+'/api/agents');assert(agents.agents.some((agent:any)=>agent.id==='csv-worker'&&agent.wallet===job.worker));assert(agents.agents.some((agent:any)=>agent.id==='independent-verifier'&&agent.wallet===job.verifier));
  return {verifiedAt:new Date().toISOString(),status:'passed',deployment:options.requirePublic===false?'local-production':'public',url:origin,network:'devnet',programId:config.programId,mint:config.mint,job:job.address,creator:job.creator,worker:job.worker,verifier:job.verifier,amount:job.amount,apiBootId:health.bootId,workersReady:true,faucetEnabled:config.faucetEnabled,inputHash:spec.input.hash,artifactHash:job.artifactHash,receiptHash:job.verificationHash,transactions,deltas,unauthorizedUploadStatus:unauthorized.status};
}
if (process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const local=process.argv.includes('--local');
  const url=process.env.WEB_URL??'https://otcs.ai';
  const report=await verifyHostedWorkflow({url,workflowFile:process.env.AGENTBOND_WORKFLOW_EVIDENCE??(local?'artifacts/web/hosted-local/workflow-evidence.json':'artifacts/web/hosted-public/workflow-evidence.json'),requirePublic:!local});
  const file=local?'.orchestrator/reports/fullstack-local-devnet.json':'.orchestrator/reports/fullstack-devnet.json';await writeFile(file,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
