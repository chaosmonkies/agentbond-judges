import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import type { IdlAccounts } from '@coral-xyz/anchor';
import { Connection, PublicKey, SystemProgram, type AccountInfo } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getMint, getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { resolveNetworkProfile, verifyNetworkGenesis, type NetworkProfile } from '../../shared/src/network.ts';
import idl from './idl.json' with { type: 'json' };
import type { Agentbond } from './agentbond.js';

const { AnchorProvider, Program } = anchor;
export const PROGRAM_ID = new PublicKey('FPymWjwqaqmXQ3ozKNRdBP9FNyWqQcE5TepHvUBgMB1U');
export type Wallet = ConstructorParameters<typeof AnchorProvider>[1];
export type JobStatus = 'CREATED'|'FUNDED'|'CLAIMED'|'SUBMITTED'|'VERIFIED'|'REJECTED'|'SETTLED'|'CANCELLED'|'REFUNDED';
export interface JobDTO {
  address:string; id:string; creator:string; worker:string|null; verifier:string; mint:string;
  tokenProgram:string; vault:string; amount:string; specHash:string; acceptanceHash:string;
  artifactHash:string; verificationHash:string; createdAt:number; fundedAt:number; claimedAt:number;
  submittedAt:number; verifiedAt:number; settledAt:number; claimDeadline:number; submitDeadline:number;
  verifyDeadline:number; status:JobStatus;
}
export interface CreateJobArgs {
  id:bigint|string; mint:PublicKey; amount:bigint|string; verifier:PublicKey;
  specHash:string; acceptanceHash:string; claimDeadline:number; submitDeadline:number; verifyDeadline:number;
}
export type Address = PublicKey|string;
export type JobAccount = IdlAccounts<Agentbond>['job'];
export interface ClientOptions { networkProfile?: NetworkProfile }
const key = (value:Address):PublicKey => typeof value === 'string' ? new PublicKey(value) : value;
function hashBytes(value:string):number[] {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('Expected a 32-byte hexadecimal hash');
  return Array.from({length:32},(_,i)=>parseInt(value.slice(i*2,i*2+2),16));
}
const hex = (value:number[]):string => value.map(v=>v.toString(16).padStart(2,'0')).join('');
function integer(value:bigint|string) {
  const text=value.toString();
  if (!/^\d+$/.test(text) || BigInt(text)>18446744073709551615n) throw new Error('Expected u64 integer');
  return new BN(text);
}
export function serializeJob(address:Address, job:JobAccount):JobDTO {
  return {
    address:key(address).toBase58(), id:job.id.toString(), creator:job.creator.toBase58(),
    worker:job.worker.equals(PublicKey.default)?null:job.worker.toBase58(), verifier:job.verifier.toBase58(),
    mint:job.mint.toBase58(), tokenProgram:job.tokenProgram.toBase58(), vault:job.vault.toBase58(), amount:job.amount.toString(),
    specHash:hex(job.specHash), acceptanceHash:hex(job.acceptanceHash), artifactHash:hex(job.artifactHash), verificationHash:hex(job.verificationHash),
    createdAt:job.createdAt.toNumber(), fundedAt:job.fundedAt.toNumber(), claimedAt:job.claimedAt.toNumber(), submittedAt:job.submittedAt.toNumber(),
    verifiedAt:job.verifiedAt.toNumber(), settledAt:job.settledAt.toNumber(), claimDeadline:job.claimDeadline.toNumber(), submitDeadline:job.submitDeadline.toNumber(), verifyDeadline:job.verifyDeadline.toNumber(),
    status:Object.keys(job.status)[0]!.toUpperCase() as JobStatus,
  };
}
export class AgentBondClient {
  readonly provider:InstanceType<typeof AnchorProvider>;
  readonly program:InstanceType<typeof Program<Agentbond>>;
  readonly networkProfile?:NetworkProfile;
  constructor(readonly connection:Connection, readonly wallet:Wallet, readonly programId:PublicKey=PROGRAM_ID, options:ClientOptions={}) {
    this.networkProfile=options.networkProfile ? resolveNetworkProfile(options.networkProfile) : undefined;
    if (this.networkProfile && this.networkProfile.programId !== programId.toBase58()) throw new Error('SDK program differs from network profile');
    // Guard at signature time as well as before instruction construction. No cached genesis verdict.
    const guardedWallet:Wallet=this.networkProfile ? {
      publicKey:wallet.publicKey,
      signTransaction:async tx=>{await this.assertNetwork();return wallet.signTransaction(tx);},
      signAllTransactions:async txs=>{await this.assertNetwork();return wallet.signAllTransactions(txs);},
    } : wallet;
    this.provider=new AnchorProvider(connection,guardedWallet,{commitment:'confirmed',preflightCommitment:'confirmed'});
    this.program=new Program<Agentbond>({...idl,address:programId.toBase58()} as unknown as Agentbond,this.provider);
  }
  async assertNetwork():Promise<void> {
    if (this.networkProfile) await verifyNetworkGenesis(this.networkProfile,this.connection);
  }
  private validateJobIdentity(address:PublicKey,data:JobAccount):JobAccount {
    const [canonical,bump]=PublicKey.findProgramAddressSync([new TextEncoder().encode('job'),data.creator.toBytes(),Uint8Array.from(integer(data.id.toString()).toArray('le',8))],this.programId);
    if (!canonical.equals(address) || data.bump !== bump) throw new Error('Job account is not the canonical creator/id PDA');
    const [vault,vaultBump]=PublicKey.findProgramAddressSync([new TextEncoder().encode('vault'),address.toBytes()],this.programId);
    if (!vault.equals(data.vault) || data.vaultBump !== vaultBump) throw new Error('Job vault identity does not match its canonical PDA');
    if (!data.tokenProgram.equals(TOKEN_PROGRAM_ID)) throw new Error('Job token program is unsupported');
    return data;
  }
  private decodeJob(address:PublicKey,account:AccountInfo<Buffer>):JobAccount {
    // Ownership and bytes must come from the same RPC response, before Borsh decoding.
    if (!account.owner.equals(this.programId) || account.executable) throw new Error('Job account owner does not match the AgentBond program');
    return this.validateJobIdentity(address,this.program.coder.accounts.decode<JobAccount>('job',account.data));
  }
  private async readJob(jobAddress:Address):Promise<JobAccount|null> {
    const address=key(jobAddress),account=await this.connection.getAccountInfo(address,'confirmed');
    return account ? this.decodeJob(address,account) : null;
  }
  private async checkedJob(jobAddress:Address):Promise<JobAccount> {
    await this.assertNetwork();
    const data=await this.readJob(jobAddress);
    if (!data) throw new Error('Job account not found');
    if (this.networkProfile && (data.mint.toBase58() !== this.networkProfile.mint || data.verifier.toBase58() !== this.networkProfile.verifier || !data.tokenProgram.equals(TOKEN_PROGRAM_ID))) throw new Error('Job is outside the supported network mint/verifier policy');
    return data;
  }
  private async guardJob(jobAddress:Address):Promise<void> {
    if (this.networkProfile) await this.checkedJob(jobAddress);
  }
  jobAddress(creator:PublicKey,id:bigint|string):PublicKey {
    return PublicKey.findProgramAddressSync([new TextEncoder().encode('job'),creator.toBytes(),Uint8Array.from(integer(id).toArray('le',8))],this.programId)[0];
  }
  vaultAddress(job:Address):PublicKey {
    return PublicKey.findProgramAddressSync([new TextEncoder().encode('vault'),key(job).toBytes()],this.programId)[0];
  }
  async createJob(args:CreateJobArgs):Promise<{signature:string;jobAddress:string}> {
    await this.assertNetwork();
    if (this.networkProfile) {
      if (args.mint.toBase58() !== this.networkProfile.mint || args.verifier.toBase58() !== this.networkProfile.verifier) throw new Error('Job is outside the supported network mint/verifier policy');
      const mint=await getMint(this.connection,args.mint);
      if (mint.decimals !== this.networkProfile.decimals || mint.freezeAuthority) throw new Error('Network mint decimals or freeze authority is unsupported');
    }
    for (const deadline of [args.claimDeadline,args.submitDeadline,args.verifyDeadline]) if (!Number.isSafeInteger(deadline)) throw new Error('Deadline must be integer Unix seconds');
    const job=this.jobAddress(this.wallet.publicKey,args.id), vault=this.vaultAddress(job);
    const signature=await this.program.methods.createJob(integer(args.id),integer(args.amount),args.verifier,hashBytes(args.specHash),hashBytes(args.acceptanceHash),new BN(args.claimDeadline),new BN(args.submitDeadline),new BN(args.verifyDeadline))
      .accountsStrict({creator:this.wallet.publicKey,job,mint:args.mint,vault,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).rpc();
    return {signature,jobAddress:job.toBase58()};
  }
  private async custody(jobAddress:Address) {
    const job=key(jobAddress), data=await this.checkedJob(job);
    return {job,vault:data.vault,mint:data.mint,tokenProgram:TOKEN_PROGRAM_ID};
  }
  async fundJob(job:Address,source:Address):Promise<string> {
    return this.program.methods.fundJob().accountsStrict({...await this.custody(job),creator:this.wallet.publicKey,source:key(source)}).rpc();
  }
  async claimJob(job:Address):Promise<string> {
    await this.guardJob(job);
    return this.program.methods.claimJob().accountsStrict({job:key(job),worker:this.wallet.publicKey}).rpc();
  }
  async submitWork(job:Address,artifactHash:string):Promise<string> {
    await this.guardJob(job);
    return this.program.methods.submitWork(hashBytes(artifactHash)).accountsStrict({job:key(job),worker:this.wallet.publicKey}).rpc();
  }
  async approveWork(job:Address,verificationHash:string):Promise<string> {
    await this.guardJob(job);
    return this.program.methods.approveWork(hashBytes(verificationHash)).accountsStrict({job:key(job),verifier:this.wallet.publicKey}).rpc();
  }
  async rejectWork(job:Address,verificationHash:string):Promise<string> {
    await this.guardJob(job);
    return this.program.methods.rejectWork(hashBytes(verificationHash)).accountsStrict({job:key(job),verifier:this.wallet.publicKey}).rpc();
  }
  async settleJob(job:Address,destination:Address):Promise<string> {
    return this.program.methods.settleJob().accountsStrict({...await this.custody(job),destination:key(destination)}).rpc();
  }
  async refundJob(job:Address,destination:Address):Promise<string> {
    return this.program.methods.refundJob().accountsStrict({...await this.custody(job),creator:this.wallet.publicKey,destination:key(destination)}).rpc();
  }
  async cancelJob(job:Address):Promise<string> {
    await this.guardJob(job);
    return this.program.methods.cancelJob().accountsStrict({job:key(job),creator:this.wallet.publicKey}).rpc();
  }
  /** Read-only destination lookup. Settlement always belongs to the assigned worker. */
  async workerTokenAddress(job:Address):Promise<PublicKey> {
    const data=await this.readJob(job);
    if (!data) throw new Error('Job account not found');
    if (data.worker.equals(PublicKey.default)) throw new Error('Job has no assigned worker');
    return getAssociatedTokenAddress(data.mint,data.worker,true,TOKEN_PROGRAM_ID);
  }
  /** Anyone may pay ATA rent and release VERIFIED principal to its assigned worker. */
  async settleJobToWorker(job:Address):Promise<string> {
    const data=await this.checkedJob(job);
    if (data.worker.equals(PublicKey.default)) throw new Error('Job has no assigned worker');
    const destination=await getAssociatedTokenAddress(data.mint,data.worker,true,TOKEN_PROGRAM_ID);
    const ata=createAssociatedTokenAccountIdempotentInstruction(this.wallet.publicKey,destination,data.worker,data.mint,TOKEN_PROGRAM_ID);
    return this.program.methods.settleJob().accountsStrict({job:key(job),vault:data.vault,mint:data.mint,tokenProgram:TOKEN_PROGRAM_ID,destination}).preInstructions([ata]).rpc();
  }
  async getJob(job:Address):Promise<JobDTO|null> {
    const account=await this.readJob(job);
    return account?serializeJob(job,account):null;
  }
  async listJobs():Promise<JobDTO[]> {
    return (await this.program.account.job.all()).map(({publicKey,account})=>serializeJob(publicKey,this.validateJobIdentity(publicKey,account)));
  }
  watchJob(job:Address,callback:(job:JobDTO)=>void):()=>Promise<void> {
    const address=key(job);
    const subscription=this.connection.onAccountChange(address,account=>{
      let data:JobAccount;try { data=this.decodeJob(address,account); } catch { return; }
      callback(serializeJob(address,data));
    },'confirmed');
    return ()=>this.connection.removeAccountChangeListener(subscription);
  }
}
export { idl as AGENTBOND_IDL };
