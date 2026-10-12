import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getMint, createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction } from '@solana/spl-token';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../../../packages/shared/src/index.ts';
import { assertFaucetAllowed, verifyNetworkGenesis, type NetworkProfile } from '../../../packages/shared/src/network.ts';
import { resumeDurableTransaction, sendDurableTransaction } from '../../../packages/agent-runtime/src/transaction-journal.ts';
import { SqliteMetadataStore } from './sqlite-store.ts';

export interface FaucetResult { solSignature: string; tokenSignature: string; solLamports: string; tokenUnits: string; recovered: boolean }
/** A single atomic devnet transaction; both effects have the same real signature. */
export class DevnetFaucet {
  private pending: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private available: number|null = null;
  readonly solLamports = 30_000_000; readonly tokenUnits: bigint;
  constructor(readonly options: { connection: Connection; profile: NetworkProfile; store: SqliteMetadataStore; solKey: Keypair; mintAuthority: Keypair; journalRoot: string; maxWallets?: number }) {
    assertFaucetAllowed(options.profile);
    if (options.profile.network !== 'devnet') throw new Error('Hosted faucet is devnet only');
    if (options.solKey.publicKey.equals(options.mintAuthority.publicKey)) throw new Error('Faucet SOL signer must be separate from mint authority');
    this.tokenUnits = 100n * 10n ** BigInt(options.profile.decimals);
    if (!Number.isSafeInteger(options.maxWallets ?? 50) || (options.maxWallets ?? 50)<1 || (options.maxWallets ?? 50)>100) throw new Error('Faucet capacity must be from 1 to 100');
  }
  status() { const capacity=this.options.maxWallets ?? 50,used=this.options.store.faucetCount(); return {capacity,used,remaining:Math.max(0,capacity-used),solLamports:String(this.solLamports),tokenUnits:String(this.tokenUnits),availableLamports:this.available===null?null:String(this.available),exhausted:used>=capacity || (this.available!==null && this.available<this.solLamports+3_000_000),oncePerWallet:true}; }
  async initialize() {
    const {connection,profile,mintAuthority,solKey}=this.options; await verifyNetworkGenesis(profile,connection);
    const mint=await getMint(connection,new PublicKey(profile.mint),'confirmed',TOKEN_PROGRAM_ID);
    if (mint.decimals!==profile.decimals || mint.freezeAuthority || !mint.mintAuthority?.equals(mintAuthority.publicKey)) throw new Error('Faucet configuration does not match deployed mint authority');
    this.available=await connection.getBalance(solKey.publicKey,'confirmed');
  }
  request(wallet: string): Promise<FaucetResult> {
    if (this.queued>=4) return Promise.reject(new Error('Faucet queue capacity reached'));
    this.queued++; const result = this.pending.then(() => this.fund(wallet)).finally(() => this.queued--); this.pending = result.catch(() => {}); return result;
  }
  private async fund(wallet: string): Promise<FaucetResult> {
    const { connection,profile,store,solKey,mintAuthority,journalRoot } = this.options;
    const recipient = new PublicKey(wallet); if (!PublicKey.isOnCurve(recipient.toBytes())) throw new Error('Recipient must be a signing wallet');
    await verifyNetworkGenesis(profile,connection);
    const identity = `faucet:${profile.genesisHash}:${profile.mint}:${wallet}:${this.solLamports}:${this.tokenUnits}`;
    const prior = store.faucet(wallet);
    if (prior && prior.payload.identity !== identity) throw new Error('Faucet reservation identity mismatch');
    if (prior?.state === 'COMPLETE') return { ...prior.payload.result,recovered:true };
    const mint = new PublicKey(profile.mint); const state = await getMint(connection,mint,'confirmed',TOKEN_PROGRAM_ID);
    if (state.decimals !== profile.decimals || state.freezeAuthority || !state.mintAuthority?.equals(mintAuthority.publicKey)) throw new Error('Faucet mint authority, decimals or freeze authority mismatch');
    await mkdir(journalRoot,{recursive:true,mode:0o700}); const path = join(journalRoot,sha256(identity)+'.json');
    let resumed = await resumeDurableTransaction(connection,path,identity,{polls:2,intervalMs:250});
    if (resumed?.state === 'EXPIRED') { await rename(path,`${path}.expired-${Date.now()}`); resumed=null; }
    if (!resumed) {
      const rent = await connection.getMinimumBalanceForRentExemption(165,'confirmed'); this.available=await connection.getBalance(solKey.publicKey,'confirmed');
      if (this.available<this.solLamports+rent+1_000_000) throw new Error('Devnet faucet funds exhausted; operator funding is required');
      if (!prior && !store.reserveFaucet(wallet,{identity,createdAt:Date.now()},this.options.maxWallets ?? 50)) throw new Error('Faucet reservation changed; retry once the existing request finishes');
    }
    const token = await getAssociatedTokenAddress(mint,recipient,false,TOKEN_PROGRAM_ID);
    const tx = new Transaction().add(
      SystemProgram.transfer({fromPubkey:solKey.publicKey,toPubkey:recipient,lamports:this.solLamports}),
      createAssociatedTokenAccountIdempotentInstruction(solKey.publicKey,token,recipient,mint,TOKEN_PROGRAM_ID),
      createMintToCheckedInstruction(mint,token,mintAuthority.publicKey,this.tokenUnits,profile.decimals,[],TOKEN_PROGRAM_ID),
    );
    const receipt = resumed ?? await sendDurableTransaction(connection,tx,[solKey,mintAuthority],path,identity,{polls:12,intervalMs:500});
    if (receipt.state !== 'CONFIRMED') throw new Error('Faucet transaction expired; retry the same wallet reservation');
    const result: FaucetResult = {solSignature:receipt.signature,tokenSignature:receipt.signature,solLamports:String(this.solLamports),tokenUnits:String(this.tokenUnits),recovered:receipt.recovered};
    store.updateFaucet(wallet,'COMPLETE',{identity,result}); this.available=await connection.getBalance(solKey.publicKey,'confirmed').catch(() => null); return result;
  }
}
