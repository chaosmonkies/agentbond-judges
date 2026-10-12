import { afterEach, describe, expect, it } from 'vitest';
import { Connection, Keypair, PublicKey, SystemInstruction, Transaction } from '@solana/web3.js';
import { MintLayout, TOKEN_PROGRAM_ID, decodeMintToCheckedInstruction } from '@solana/spl-token';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import bs58 from 'bs58';
import { DevnetFaucet } from '../../apps/api/src/faucet.ts';
import { SqliteMetadataStore } from '../../apps/api/src/sqlite-store.ts';
import { DEVNET_PROFILE, NETWORK_GENESIS } from '../../packages/shared/src/network.ts';

describe('devnet faucet quotas and real signed transaction boundaries (fake RPC)',()=>{
  const cleanups:(()=>Promise<void>)[]=[];
  afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
  async function fixture(maxWallets=50) {
    const root=await mkdtemp(join(tmpdir(),'agentbond-faucet-')),store=new SqliteMetadataStore(join(root,'state.sqlite'));await store.load();
    cleanups.push(async()=>{store.close();await rm(root,{recursive:true,force:true});});
    const solKey=Keypair.generate(),mintAuthority=Keypair.generate(),recipient=Keypair.generate();let funds=2_000_000_000,genesis:string=NETWORK_GENESIS.devnet,freeze=false,lost=false,sends=0;
    const statuses=new Map<string,{confirmationStatus:string;err:null}>();
    const connection={
      getGenesisHash:async()=>genesis,
      getAccountInfo:async()=>{const data=Buffer.alloc(MintLayout.span);MintLayout.encode({mintAuthorityOption:1,mintAuthority:mintAuthority.publicKey,supply:0n,decimals:6,isInitialized:true,freezeAuthorityOption:freeze?1:0,freezeAuthority:freeze?mintAuthority.publicKey:PublicKey.default},data);return{data,owner:TOKEN_PROGRAM_ID,executable:false,lamports:2_000_000,rentEpoch:0};},
      getMinimumBalanceForRentExemption:async()=>2_039_280,getBalance:async()=>funds,
      getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}),getBlockHeight:async()=>90,isBlockhashValid:async()=>({value:true}),
      getSignatureStatuses:async(signatures:string[])=>({value:signatures.map(value=>statuses.get(value)??null)}),
      sendRawTransaction:async(raw:Uint8Array)=>{sends++;const tx=Transaction.from(Buffer.from(raw));expect(tx.verifySignatures()).toBe(true);expect(tx.instructions).toHaveLength(3);expect(tx.signatures).toHaveLength(2);
        const transfer=SystemInstruction.decodeTransfer(tx.instructions[0]);expect(transfer).toMatchObject({lamports:30_000_000n});expect(transfer.fromPubkey.equals(solKey.publicKey)).toBe(true);
        const mint=decodeMintToCheckedInstruction(tx.instructions[2]);expect(mint.data.amount).toBe(100_000_000n);expect(mint.keys.authority.pubkey.equals(mintAuthority.publicKey)).toBe(true);expect(mint.keys.mint.pubkey.toBase58()).toBe(DEVNET_PROFILE.mint);
        const signature=bs58.encode(tx.signature!);statuses.set(signature,{confirmationStatus:'confirmed',err:null});funds-=30_000_000;if(lost)throw Error('Transport lost after broadcast');return signature;},
    } as unknown as Connection;
    const options={connection,profile:DEVNET_PROFILE,store,solKey,mintAuthority,journalRoot:join(root,'journals'),maxWallets};
    const faucet=new DevnetFaucet(options);return{root,store,options,faucet,recipient,connection,sends:()=>sends,funds:(value:number)=>{funds=value;},genesis:(value:string)=>{genesis=value;},freeze:()=>{freeze=true;},lose:()=>{lost=true;}};
  }
  it('atomically signs separate SOL and mint authorities, reconciles lost response and preserves once-wallet result after restart',async()=>{
    const env=await fixture();env.lose();await env.faucet.initialize();const wallet=env.recipient.publicKey.toBase58();const result=await env.faucet.request(wallet);
    expect(result.solSignature).toBe(result.tokenSignature);expect(result).toMatchObject({solLamports:'30000000',tokenUnits:'100000000'});expect(env.sends()).toBe(1);
    const restarted=new DevnetFaucet(env.options);expect(await restarted.request(wallet)).toEqual({...result,recovered:true});expect(env.sends()).toBe(1);expect(env.store.faucetCount()).toBe(1);
  });
  it('checks funds before reserving a new wallet and exposes exhaustion without signing',async()=>{
    const env=await fixture();env.funds(1);await env.faucet.initialize();expect(env.faucet.status().exhausted).toBe(true);
    await expect(env.faucet.request(env.recipient.publicKey.toBase58())).rejects.toThrow('funds exhausted');expect(env.store.faucetCount()).toBe(0);expect(env.sends()).toBe(0);
  });
  it('rejects wrong RPC genesis and freeze authority before reserving or broadcasting',async()=>{
    const env=await fixture();env.genesis(NETWORK_GENESIS['mainnet-beta']);await expect(env.faucet.request(env.recipient.publicKey.toBase58())).rejects.toThrow('genesis mismatch');
    env.genesis(NETWORK_GENESIS.devnet);env.freeze();await expect(env.faucet.request(env.recipient.publicKey.toBase58())).rejects.toThrow('freeze authority');expect(env.sends()).toBe(0);expect(env.store.faucetCount()).toBe(0);
  });
  it('enforces persistent global capacity while repeated same-wallet requests return the original effect',async()=>{
    const env=await fixture(1);const wallet=env.recipient.publicKey.toBase58();const first=await env.faucet.request(wallet);await expect(env.faucet.request(Keypair.generate().publicKey.toBase58())).rejects.toThrow('capacity');
    expect((await env.faucet.request(wallet)).solSignature).toBe(first.solSignature);expect(env.sends()).toBe(1);expect(env.faucet.status()).toMatchObject({remaining:0,exhausted:true,capacity:1});
  });
  it('bounds pending request queue and forbids using one key for both custody roles',async()=>{
    const env=await fixture();const requests=Array.from({length:4},()=>env.faucet.request(env.recipient.publicKey.toBase58()));await expect(env.faucet.request(env.recipient.publicKey.toBase58())).rejects.toThrow('queue capacity');await Promise.all(requests);expect(env.sends()).toBe(1);
    expect(()=>new DevnetFaucet({...env.options,mintAuthority:env.options.solKey})).toThrow('separate');
  });
});
