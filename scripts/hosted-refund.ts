import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import anchor from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { getAccount,getAssociatedTokenAddress } from '@solana/spl-token';
import { AgentBondClient } from '../packages/sdk/src/index.ts';
import { DEVNET_PROFILE,verifyNetworkGenesis,explorerUrl } from '../packages/shared/src/network.ts';
import { sha256,specificationHashes } from '../packages/shared/src/index.ts';
import { loadExternalKeypair } from '../packages/agent-runtime/src/signing.ts';
import { createRuntimeConnection } from '../packages/agent-runtime/src/rpc.ts';
import { sendDurableTransaction } from '../packages/agent-runtime/src/transaction-journal.ts';
import { recoverJobTransactions,tokenBalanceSnapshot,isExpectedAnchorError } from '../packages/agent-runtime/src/chain-evidence.ts';
import { authorizedHostedPost } from './hosted-wallet.ts';

if(!process.argv.includes('--apply'))throw new Error('This performs authorized devnet test effects; pass --apply explicitly');
const local=process.argv.includes('--local'),origin=new URL(process.env.WEB_URL??'https://otcs.ai').origin;
if(!local)assert(origin.startsWith('https://'));
const directory=process.env.AGENTBOND_SOURCE_KEY_DIR??join(homedir(),'.agentbond','keys');
const key=await loadExternalKeypair(process.env.AGENTBOND_HOSTED_WALLET_PATH??join(directory,'creator.json'));
const rpc=createRuntimeConnection(DEVNET_PROFILE.rpcUrl);await verifyNetworkGenesis(DEVNET_PROFILE,rpc);
const client=new AgentBondClient(rpc,new anchor.Wallet(key),new PublicKey(DEVNET_PROFILE.programId),{networkProfile:DEVNET_PROFILE});
const file=`.orchestrator/reports/hosted-refund${local?'-local':''}.json`;
let proof:any;
try{proof=JSON.parse(await readFile(file,'utf8'));assert(proof.url===origin&&proof.creator===key.publicKey.toBase58()&&proof.network==='devnet');}
catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const id=(BigInt(Date.now())*100n+7n).toString();proof={status:'running',url:origin,deployment:local?'local-production':'public',network:'devnet',creator:key.publicKey.toBase58(),id,job:client.jobAddress(key.publicKey,id).toBase58(),amount:'1000000',startedAt:new Date().toISOString()};}
const checkpoint=()=>writeFile(file,JSON.stringify(proof,null,2),{flush:true});await checkpoint();
const csv=Buffer.from('day,revenue\nMon,not-a-number\n');
if(!proof.spec){const upload=await authorizedHostedPost(origin,key,'upload-input','/inputs',csv,'text/csv');assert.equal(upload.input.hash,sha256(csv));proof.spec={type:'csv-analysis',input:upload.input,acceptance:{numericColumns:['revenue'],anomaly:{column:'revenue',threshold:1000,direction:'above'}}};delete proof.spec.input.bytes;await checkpoint();}
let job=await client.getJob(proof.job);
if(!job){const time=await rpc.getBlockTime(await rpc.getSlot('confirmed'));assert(time!==null);await client.createJob({id:proof.id,mint:new PublicKey(DEVNET_PROFILE.mint),amount:proof.amount,verifier:new PublicKey(DEVNET_PROFILE.verifier),...specificationHashes(proof.spec),claimDeadline:time+30,submitDeadline:time+45,verifyDeadline:time+60});job=await client.getJob(proof.job);}
assert(job&&job.creator===proof.creator&&job.amount===proof.amount);
await authorizedHostedPost(origin,key,'job-metadata','/jobs',JSON.stringify({address:proof.job,title:'Hosted invalid numeric CSV · deadline refund',spec:proof.spec}));
const ata=await getAssociatedTokenAddress(new PublicKey(DEVNET_PROFILE.mint),key.publicKey);
if(job.status==='CREATED'){await client.fundJob(job.address,ata);job=await client.getJob(job.address);}
const deadline=Date.now()+120000;
while(job&&job.status!=='REFUNDED'){
 assert(!['VERIFIED','SETTLED'].includes(job.status),'Invalid numeric CSV must not receive approval or settlement');
 const time=await rpc.getBlockTime(await rpc.getSlot('confirmed'));assert(time!==null);
 const eligible=job.status==='REJECTED'||job.status==='FUNDED'&&time>job.claimDeadline||job.status==='CLAIMED'&&time>job.submitDeadline||job.status==='SUBMITTED'&&time>job.verifyDeadline;
 if(eligible){await client.assertNetwork();const transaction=await client.program.methods.refundJob().accountsStrict({job:new PublicKey(job.address),vault:new PublicKey(job.vault),mint:new PublicKey(job.mint),tokenProgram:new PublicKey(job.tokenProgram),creator:key.publicKey,destination:ata}).transaction();await mkdir(directory,{recursive:true,mode:0o700});const result=await sendDurableTransaction(rpc,transaction,key,join(directory,`${job.address}.refund.pending.json`),`hosted-refund:${DEVNET_PROFILE.genesisHash}:${job.address}:${ata.toBase58()}`);assert.equal(result.state,'CONFIRMED');break;}
 if(Date.now()>deadline)throw new Error('Refund deadline verification timed out; resume existing recorded job');
 await new Promise(resolve=>setTimeout(resolve,3000));job=await client.getJob(proof.job);
}
job=await client.getJob(proof.job);assert(job?.status==='REFUNDED');
const beforeRecipient=(await getAccount(rpc,ata)).amount,beforeVault=(await getAccount(rpc,new PublicKey(job.vault))).amount;
let rejected=false;try{await client.refundJob(job.address,ata);}catch(error){assert(isExpectedAnchorError(error,'RefundUnavailable'),'Network failure is not proof of duplicate-refund prevention');rejected=true;}
assert(rejected);assert.deepEqual(await client.getJob(job.address),job);assert.equal((await getAccount(rpc,ata)).amount,beforeRecipient);assert.equal((await getAccount(rpc,new PublicKey(job.vault))).amount,beforeVault);
const transactions=await recoverJobTransactions(rpc,client,job.address,signature=>explorerUrl(DEVNET_PROFILE,signature,'tx'));const terminal=transactions.find(tx=>tx.action==='refund');assert(terminal);
const tx=await rpc.getTransaction(terminal.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});assert(tx);const deltas=tokenBalanceSnapshot(tx,{recipient:ata.toBase58(),vault:job.vault},job.mint);assert.equal(BigInt(deltas.recipientAfter)-BigInt(deltas.recipientBefore),BigInt(proof.amount));assert.equal(BigInt(deltas.vaultBefore)-BigInt(deltas.vaultAfter),BigInt(proof.amount));assert.equal(deltas.vaultAfter,'0');
Object.assign(proof,{status:'passed',chainStatus:'REFUNDED',signature:terminal.signature,transactions,deltas,doubleRefundRejected:true,finishedAt:new Date().toISOString()});await checkpoint();console.log(JSON.stringify(proof,null,2));
