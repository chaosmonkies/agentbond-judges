/** Actual local-validator custody and authorization regression. No mocked RPC. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureKeys } from '../../scripts/keys.ts';
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { AgentBondClient, PROGRAM_ID } from '../../packages/sdk/src/index.js';
const {Wallet}=anchor;
const connection=new Connection(process.env.SOLANA_RPC_URL??process.env.RPC_URL??'http://127.0.0.1:8899','confirmed');
const keyDir=await ensureKeys();
const load=async(name:string)=>Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(keyDir,`${name}.json`),'utf8'))));
const creator=await load('creator'),worker=await load('worker'),verifier=await load('verifier'),deployer=await load('deployer');
const attacker=Keypair.generate();
const evidence:{startedAt:string;network:string;programId:string;tests:{name:string;result:string;signature?:string;error?:string}[];balances?:Record<string,string>;mint?:string;finishedAt?:string}={startedAt:new Date().toISOString(),network:connection.rpcEndpoint,programId:PROGRAM_ID.toBase58(),tests:[]};
await mkdir('tests/chain/artifacts',{recursive:true});
async function record() { await writeFile('tests/chain/artifacts/results.json',JSON.stringify(evidence,null,2)); }
async function success(name:string,action:()=>Promise<string|void>) {
  const signature=await action(); evidence.tests.push({name,result:'PASS',...(signature?{signature}:{})}); await record(); console.log(`PASS ${name}${signature?` ${signature}`:''}`);
}
async function denied(name:string,action:()=>Promise<unknown>,pattern:RegExp) {
  let caught:unknown;try {await action();} catch(error){caught=error;}
  assert.ok(caught,`${name}: action unexpectedly succeeded`); const message=String(caught);
  assert.match(message,pattern,`${name}: failed for unintended reason`);
  evidence.tests.push({name,result:'PASS',error:message.slice(0,1500)}); await record(); console.log(`PASS ${name}`);
}
async function clock(){ const info=await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);assert.ok(info);return Number(info.data.readBigInt64LE(32)); }
async function waitUntil(deadline:number){ while(await clock()<deadline){await new Promise(r=>setTimeout(r,350));} }
async function balance(address:PublicKey){ return (await getAccount(connection,address)).amount; }
const clients=[creator,worker,verifier,attacker].map(k=>new AgentBondClient(connection,new Wallet(k),PROGRAM_ID));
const [c,w,v,a]=clients;
for(const signer of [creator,worker,verifier,deployer,attacker]) {
  if(await connection.getBalance(signer.publicKey)<1_000_000_000) {
    const signature=await connection.requestAirdrop(signer.publicKey,2_000_000_000);
    const latest=await connection.getLatestBlockhash();await connection.confirmTransaction({signature,...latest},'confirmed');
  }
}
const mint=await createMint(connection,deployer,deployer.publicKey,null,6);
evidence.mint=mint.toBase58();
const creatorAccount=(await getOrCreateAssociatedTokenAccount(connection,deployer,mint,creator.publicKey)).address;
const workerAccount=(await getOrCreateAssociatedTokenAccount(connection,deployer,mint,worker.publicKey)).address;
const attackerAccount=(await getOrCreateAssociatedTokenAccount(connection,deployer,mint,attacker.publicKey)).address;
await mintTo(connection,deployer,mint,creatorAccount,deployer,10_000_000n);
const amount=1_000_000n;let id=BigInt(Date.now());
const hash='12'.repeat(32),artifactHash='34'.repeat(32),verificationHash='56'.repeat(32);
const makeArgs=async()=>{const now=await clock();return {id:(id++).toString(),mint,amount:amount.toString(),verifier:verifier.publicKey,specHash:hash,acceptanceHash:hash,claimDeadline:now+120,submitDeadline:now+240,verifyDeadline:now+360};};
async function make(){const result=await c.createJob(await makeArgs());await success('create '+result.jobAddress,async()=>result.signature);return new PublicKey(result.jobAddress);}
const job=await make();const vault=c.vaultAddress(job);
const creatorStart=await balance(creatorAccount);
await denied('settlement before worker assignment',()=>a.settleJob(job,workerAccount),/WrongDestination/);
await denied('unauthorized funding signer',()=>a.fundJob(job,creatorAccount),/ConstraintHasOne/);
await success('fund real SPL escrow',()=>c.fundJob(job,creatorAccount));
assert.equal(await balance(vault),amount);assert.equal(await balance(creatorAccount),creatorStart-amount);
await denied('duplicate funding',()=>c.fundJob(job,creatorAccount),/InvalidState/);
await denied('cancel funded escrow',()=>c.cancelJob(job),/InvalidState/);
await denied('premature refund',()=>c.refundJob(job,creatorAccount),/RefundUnavailable/);
await denied('creator role conflict',()=>c.claimJob(job),/RoleConflict/);
await denied('verifier role conflict',()=>v.claimJob(job),/RoleConflict/);
await success('worker claims',()=>w.claimJob(job));
await denied('settlement before approval',()=>a.settleJob(job,workerAccount),/InvalidState/);
await denied('duplicate claim',()=>a.claimJob(job),/InvalidState/);
await denied('unauthorized submission',()=>a.submitWork(job,artifactHash),/ConstraintHasOne/);
await success('worker submits commitment',()=>w.submitWork(job,artifactHash));
await denied('replayed submission',()=>w.submitWork(job,artifactHash),/InvalidState/);
await denied('unauthorized approval',()=>a.approveWork(job,verificationHash),/ConstraintHasOne/);
await denied('unauthorized rejection',()=>c.rejectWork(job,verificationHash),/ConstraintHasOne/);
await success('designated verifier approves',()=>v.approveWork(job,verificationHash));
await denied('creator clawback after VERIFIED',()=>c.refundJob(job,creatorAccount),/RefundUnavailable/);
await denied('rejection after approval',()=>v.rejectWork(job,verificationHash),/InvalidState/);
await denied('settlement account substitution',()=>a.settleJob(job,attackerAccount),/WrongDestination/);
const workerBefore=await balance(workerAccount);
await success('permissionless exactly-once settlement',()=>a.settleJob(job,workerAccount));
assert.equal(await balance(workerAccount),workerBefore+amount);assert.equal(await balance(vault),0n);
assert.equal((await c.getJob(job))?.status,'SETTLED');
await denied('double settlement',()=>w.settleJob(job,workerAccount),/InvalidState/);
await denied('terminal refund',()=>c.refundJob(job,creatorAccount),/RefundUnavailable/);
await denied('terminal claim',()=>a.claimJob(job),/InvalidState/);
await denied('duplicate job PDA',async()=>c.createJob({...await makeArgs(),id:(await c.getJob(job))!.id}),/already in use/);
const rejected=await make();await c.fundJob(rejected,creatorAccount);await w.claimJob(rejected);await w.submitWork(rejected,artifactHash);
await success('designated verifier rejects',()=>v.rejectWork(rejected,verificationHash));
await denied('refund authority substitution',()=>a.refundJob(rejected,attackerAccount),/ConstraintHasOne/);
await denied('refund destination substitution',()=>c.refundJob(rejected,attackerAccount),/ConstraintTokenOwner/);
const refundBefore=await balance(creatorAccount);
await success('rejected job refund',()=>c.refundJob(rejected,creatorAccount));
assert.equal(await balance(creatorAccount),refundBefore+amount);assert.equal(await balance(c.vaultAddress(rejected)),0n);
await denied('double refund',()=>c.refundJob(rejected,creatorAccount),/RefundUnavailable/);
const otherMint=await createMint(connection,deployer,deployer.publicKey,null,6);
const otherAccount=(await getOrCreateAssociatedTokenAccount(connection,deployer,otherMint,creator.publicKey)).address;
const unfunded=await make();
await denied('wrong source mint',()=>c.fundJob(unfunded,otherAccount),/ConstraintTokenMint/);
await denied('wrong vault PDA',()=>c.program.methods.fundJob().accountsStrict({creator:creator.publicKey,job:unfunded,source:creatorAccount,vault,mint,tokenProgram:TOKEN_PROGRAM_ID}).rpc(),/ConstraintHasOne|ConstraintSeeds/);
await denied('wrong mint account',()=>c.program.methods.fundJob().accountsStrict({creator:creator.publicKey,job:unfunded,source:creatorAccount,vault:c.vaultAddress(unfunded),mint:otherMint,tokenProgram:TOKEN_PROGRAM_ID}).rpc(),/ConstraintHasOne/);
await denied('wrong token program',()=>c.program.methods.fundJob().accountsStrict({creator:creator.publicKey,job:unfunded,source:creatorAccount,vault:c.vaultAddress(unfunded),mint,tokenProgram:SystemProgram.programId}).rpc(),/InvalidProgramId/);
await denied('unauthorized cancel',()=>a.cancelJob(unfunded),/ConstraintHasOne/);
await success('creator cancels unfunded job',()=>c.cancelJob(unfunded));
await denied('post-cancel funding',()=>c.fundJob(unfunded,creatorAccount),/InvalidState/);
await denied('invalid zero amount',async()=>c.createJob({...await makeArgs(),amount:'0'}),/InvalidAmount/);
await denied('invalid deadline ordering',async()=>{const args=await makeArgs();return c.createJob({...args,submitDeadline:args.claimDeadline});},/InvalidDeadlines/);
await denied('invalid zero spec hash',async()=>c.createJob({...await makeArgs(),specHash:'00'.repeat(32)}),/InvalidHash/);
await denied('creator as verifier',async()=>c.createJob({...await makeArgs(),verifier:creator.publicKey}),/InvalidVerifier/);
const frozenMint=await createMint(connection,deployer,deployer.publicKey,deployer.publicKey,6);
await denied('mint freeze authority rejected',async()=>c.createJob({...await makeArgs(),mint:frozenMint}),/FreezeAuthorityUnsupported/);
const token2022Mint=await createMint(connection,deployer,deployer.publicKey,null,6,undefined,undefined,TOKEN_2022_PROGRAM_ID);
await denied('Token-2022 mint rejected',async()=>c.createJob({...await makeArgs(),mint:token2022Mint}),/AccountOwnedByWrongProgram/);
const now=await clock();const deadlines={claimDeadline:now+30,submitDeadline:now+35,verifyDeadline:now+40};
const expiredFunded=new PublicKey((await c.createJob({...await makeArgs(),...deadlines})).jobAddress);
const expiredClaimed=new PublicKey((await c.createJob({...await makeArgs(),...deadlines})).jobAddress);
const expiredSubmitted=new PublicKey((await c.createJob({...await makeArgs(),...deadlines})).jobAddress);
const approvedExpired=new PublicKey((await c.createJob({...await makeArgs(),...deadlines})).jobAddress);
for(const j of [expiredFunded,expiredClaimed,expiredSubmitted,approvedExpired]) await c.fundJob(j,creatorAccount);
for(const j of [expiredClaimed,expiredSubmitted,approvedExpired]) await w.claimJob(j);
for(const j of [expiredSubmitted,approvedExpired]) await w.submitWork(j,artifactHash);
await v.approveWork(approvedExpired,verificationHash);
await waitUntil(deadlines.claimDeadline);
await denied('late claim',()=>w.claimJob(expiredFunded),/DeadlinePassed/);
await success('unclaimed deadline refund',()=>c.refundJob(expiredFunded,creatorAccount));
await waitUntil(deadlines.submitDeadline);
await denied('late submission',()=>w.submitWork(expiredClaimed,artifactHash),/DeadlinePassed/);
await success('missed submission refund',()=>c.refundJob(expiredClaimed,creatorAccount));
await waitUntil(deadlines.verifyDeadline);
await denied('late approval',()=>v.approveWork(expiredSubmitted,verificationHash),/DeadlinePassed/);
await success('nonresponsive verifier refund',()=>c.refundJob(expiredSubmitted,creatorAccount));
await denied('expired VERIFIED clawback',()=>c.refundJob(approvedExpired,creatorAccount),/RefundUnavailable/);
await success('VERIFIED settles after deadline',()=>a.settleJob(approvedExpired,workerAccount));
for(const j of [expiredFunded,expiredClaimed,expiredSubmitted,approvedExpired]) assert.equal(await balance(c.vaultAddress(j)),0n);
assert.equal(await balance(workerAccount),2n*amount);assert.equal(await balance(creatorAccount),8_000_000n);
evidence.balances={creator:(await balance(creatorAccount)).toString(),worker:(await balance(workerAccount)).toString(),vault:(await balance(vault)).toString()};
evidence.finishedAt=new Date().toISOString();await record();console.log(`PASS ${evidence.tests.length} validator-backed checks; exact creator=8000000 worker=2000000 vault=0 base units`);
