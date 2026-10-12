import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { DEVNET_PROFILE, verifyNetworkGenesis } from '../packages/shared/src/network.ts';
import { loadExternalKeypair } from '../packages/agent-runtime/src/signing.ts';
import { resumeDurableTransaction, sendDurableTransaction } from '../packages/agent-runtime/src/transaction-journal.ts';

const directory=process.env.AGENTBOND_SOURCE_KEY_DIR??join(homedir(),'.agentbond','keys');
const path=join(directory,'faucet-devnet.json');
await mkdir(directory,{recursive:true,mode:0o700});
try { await readFile(path); } catch(error) {
  if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
  if (!process.argv.includes('--apply')) throw new Error('Separate devnet faucet key is missing; --apply generates it outside the repository');
  await writeFile(path,JSON.stringify([...Keypair.generate().secretKey]),{mode:0o600,flag:'wx'});
}
const [faucet,deployer]=await Promise.all([loadExternalKeypair(path),loadExternalKeypair(join(directory,'deployer.json'))]);
const rpc=new Connection(DEVNET_PROFILE.rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true});await verifyNetworkGenesis(DEVNET_PROFILE,rpc);
const target=2_000_000_000, reserve=500_000_000;
const balance=await rpc.getBalance(faucet.publicKey),deployerBalance=await rpc.getBalance(deployer.publicKey);
console.log(JSON.stringify({network:'devnet',faucet:faucet.publicKey.toBase58(),balance,target,deployerReserve:reserve,apply:process.argv.includes('--apply')},null,2));
if (!process.argv.includes('--apply')) process.exit(0);
const identity=`hosted-faucet-initial:${DEVNET_PROFILE.genesisHash}:${faucet.publicKey.toBase58()}:${target}`;
const journal=join(directory,'hosted-faucet-initial.pending.json');
const prior=await resumeDurableTransaction(rpc,journal,identity);
if (prior?.state==='EXPIRED') throw new Error('Initial funding journal expired; inspect/reconcile before authorizing a replacement');
let result=prior;
if (!result && balance < target) {
  const amount=target-balance;
  if (deployerBalance < amount+reserve+10000) throw new Error('Insufficient devnet SOL above deployer reserve; no funding signed');
  result=await sendDurableTransaction(rpc,new Transaction().add(SystemProgram.transfer({fromPubkey:deployer.publicKey,toPubkey:faucet.publicKey,lamports:amount})),deployer,journal,identity);
}
if (result && result.state!=='CONFIRMED') throw new Error('Hosted funding remains unresolved; preserve its journal');
const report={verifiedAt:new Date().toISOString(),network:'devnet',faucet:faucet.publicKey.toBase58(),balance:await rpc.getBalance(faucet.publicKey),initialFunding:result,target};
await writeFile('.orchestrator/hosted-faucet-funding.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
